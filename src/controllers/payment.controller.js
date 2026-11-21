import { env } from '../config/env.js';
import {
  bookingRepository,
  paymentRepository,
  userRepository
} from '../repositories/index.js';
import { requireCanonicalActor } from '../utils/actorIdentity.js';
import { AppError } from '../utils/AppError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { pickAllowedFields } from '../utils/projections.js';
import {
  checkoutSessionInputSchema,
  emailSchema,
  objectIdSchema,
  PAYMENT_CURRENCIES,
  paymentVerificationQuerySchema,
  stripeSessionIdSchema
} from '../validators/index.js';

const defaultGetActor = (req) => req.actor;
const PAYMENT_CURRENCY = PAYMENT_CURRENCIES[0];
const PAYMENT_CUSTOMER_RESPONSE_FIELDS = Object.freeze([
  'bookingId',
  'serviceTitle',
  'amount',
  'currency',
  'paymentStatus',
  'paidAt'
]);
const PAYMENT_BOOKING_RESPONSE_FIELDS = Object.freeze([
  '_id',
  'serviceTitle',
  'status',
  'finalAmount',
  'paymentStatus'
]);
const SUPPORTED_WEBHOOK_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded'
]);

const parseInput = (schema, value, code, message) => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new AppError(400, code, message);
  }

  return result.data;
};

const paymentResponse = (payment) =>
  pickAllowedFields(payment, PAYMENT_CUSTOMER_RESPONSE_FIELDS);

const bookingPaymentResponse = (booking) =>
  pickAllowedFields(booking, PAYMENT_BOOKING_RESPONSE_FIELDS);

const paymentResultResponse = (result) => ({
  payment: paymentResponse(result.payment),
  booking: bookingPaymentResponse(result.booking),
  alreadyFulfilled: result.alreadyFulfilled
});

const requireCheckoutClient = (stripeClient) => {
  if (
    typeof stripeClient?.checkout?.sessions?.create !== 'function' ||
    typeof stripeClient?.checkout?.sessions?.retrieve !== 'function'
  ) {
    throw new AppError(
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'Payment provider is unavailable.'
    );
  }
};

const getAmountInCents = (booking) => {
  const amount = Number(booking?.finalAmount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError(
      409,
      'INVALID_PAYMENT_AMOUNT',
      'Booking does not have a valid payable amount.'
    );
  }

  return Math.round(amount * 100);
};

const getNormalizedOrigin = (clientOrigin) =>
  String(clientOrigin ?? env.allowedOrigins[0] ?? '').replace(/\/+$/, '');

const isDuplicateKeyError = (error) =>
  error instanceof AppError && error.code === 'DUPLICATE_KEY';

export const createPaymentController = ({
  stripeClient = null,
  payments = paymentRepository,
  bookings = bookingRepository,
  users = userRepository,
  getActor = defaultGetActor,
  clientOrigin = env.allowedOrigins[0]
} = {}) => {
  if (typeof getActor !== 'function') {
    throw new TypeError('createPaymentController requires a getActor function.');
  }

  const requireCustomer = async (req) => {
    const customer = await requireCanonicalActor({
      req,
      users,
      role: 'customer',
      getActor
    });

    return { actor: customer, user: customer };
  };

  const markBookingPaid = async (bookingId) => {
    try {
      return await bookings.updatePaymentStatus(bookingId, 'paid');
    } catch (error) {
      if (
        error instanceof AppError &&
        ['PAYMENT_CONFLICT', 'PAYMENT_NOT_ALLOWED'].includes(error.code)
      ) {
        const latest = await bookings.findById(bookingId);

        if (latest?.paymentStatus === 'paid') {
          return latest;
        }
      }

      throw error;
    }
  };

  const markBookingPaidAfterPayment = async (bookingId) => {
    try {
      return await markBookingPaid(bookingId);
    } catch {
      throw new AppError(
        409,
        'PAYMENT_RECONCILIATION_REQUIRED',
        'Payment was recorded. Retry the verified callback to reconcile booking payment status.'
      );
    }
  };

  const assertStoredPaymentMatchesBooking = (payment, verified) => {
    if (
      String(payment?.bookingId) !== String(verified.bookingId) ||
      String(payment?.customerEmail) !== String(verified.customerEmail) ||
      Number(payment?.amount) !== Number(verified.booking.finalAmount) ||
      payment?.currency !== PAYMENT_CURRENCY ||
      payment?.paymentStatus !== 'paid'
    ) {
      throw new AppError(
        409,
        'PAYMENT_SESSION_MISMATCH',
        'Existing payment does not match the verified booking.'
      );
    }
  };

  const getStoredPaymentSessionId = (payment, verified) => {
    assertStoredPaymentMatchesBooking(payment, verified);

    return parseInput(
      stripeSessionIdSchema,
      payment?.stripeSessionId,
      'PAYMENT_SESSION_MISMATCH',
      'Existing payment has an invalid Stripe session ID.'
    );
  };

  const loadVerifiedBookingForSession = async ({
    session,
    expectedCustomerEmail
  }) => {
    if (
      session?.object !== 'checkout.session' ||
      (session.mode && session.mode !== 'payment')
    ) {
      throw new AppError(409, 'INVALID_STRIPE_SESSION', 'Invalid Stripe session.');
    }

    if (session.payment_status !== 'paid') {
      throw new AppError(409, 'PAYMENT_NOT_PAID', 'Stripe session is not paid.');
    }

    const metadata = session.metadata ?? {};
    const bookingId = parseInput(
      objectIdSchema,
      metadata.bookingId,
      'INVALID_SESSION_METADATA',
      'Stripe session metadata is invalid.'
    );
    const customerEmail = emailSchema.safeParse(metadata.customerEmail);

    if (!customerEmail.success) {
      throw new AppError(
        409,
        'INVALID_SESSION_METADATA',
        'Stripe session metadata is invalid.'
      );
    }

    if (
      expectedCustomerEmail &&
      customerEmail.data !== String(expectedCustomerEmail).toLowerCase()
    ) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Payment session belongs to a different customer.'
      );
    }

    const booking = await bookings.findById(bookingId);

    if (!booking) {
      throw new AppError(404, 'NOT_FOUND', 'Booking not found.');
    }

    if (String(booking.customerEmail) !== customerEmail.data) {
      throw new AppError(
        409,
        'PAYMENT_SESSION_MISMATCH',
        'Stripe session does not match the booking.'
      );
    }

    if (booking.status !== 'completed') {
      throw new AppError(
        409,
        'PAYMENT_NOT_ALLOWED',
        'Only a completed booking can be paid.'
      );
    }

    const expectedAmount = getAmountInCents(booking);

    if (Number(session.amount_total) !== expectedAmount) {
      throw new AppError(
        409,
        'PAYMENT_AMOUNT_MISMATCH',
        'Stripe session amount does not match the booking.'
      );
    }

    if (session.currency !== PAYMENT_CURRENCY) {
      throw new AppError(
        409,
        'PAYMENT_CURRENCY_MISMATCH',
        'Stripe session currency is not supported.'
      );
    }

    return { booking, bookingId, customerEmail: customerEmail.data, expectedAmount };
  };

  const reconcileExistingPayment = async ({ payment, verified, sessionId }) => {
    const storedSessionId = getStoredPaymentSessionId(payment, verified);

    if (sessionId && storedSessionId !== sessionId) {
      throw new AppError(
        409,
        'PAYMENT_SESSION_MISMATCH',
        'Existing payment does not match the verified Stripe session.'
      );
    }

    if (verified.booking.paymentStatus === 'paid') {
      return {
        payment,
        booking: verified.booking,
        alreadyFulfilled: true,
        stripeSessionId: storedSessionId
      };
    }

    const updatedBooking = await markBookingPaidAfterPayment(verified.bookingId);

    return {
      payment,
      booking: updatedBooking,
      alreadyFulfilled: true,
      stripeSessionId: storedSessionId
    };
  };

  const handleExistingBookingPayment = async ({
    payment,
    verified,
    attemptedSessionId
  }) => {
    const storedSessionId = getStoredPaymentSessionId(payment, verified);

    if (storedSessionId === attemptedSessionId) {
      return reconcileExistingPayment({
        payment,
        verified,
        sessionId: attemptedSessionId
      });
    }

    await reconcileExistingPayment({
      payment,
      verified,
      sessionId: storedSessionId
    });

    throw new AppError(
      409,
      'PAYMENT_SESSION_CONFLICT',
      'This booking was fulfilled by a different Stripe session.'
    );
  };

  const fulfillPaidCheckoutSession = async ({
    session,
    expectedSessionId,
    expectedCustomerEmail
  }) => {
    const sessionId = parseInput(
      stripeSessionIdSchema,
      session?.id,
      'INVALID_STRIPE_SESSION',
      'Invalid Stripe session.'
    );

    if (expectedSessionId && sessionId !== expectedSessionId) {
      throw new AppError(
        409,
        'PAYMENT_SESSION_MISMATCH',
        'Stripe session ID does not match the requested session.'
      );
    }

    const verified = await loadVerifiedBookingForSession({
      session,
      expectedCustomerEmail
    });
    const existingBookingPayment = await payments.findByBookingId(verified.bookingId);

    if (existingBookingPayment) {
      return handleExistingBookingPayment({
        payment: existingBookingPayment,
        verified,
        attemptedSessionId: sessionId
      });
    }

    if (verified.booking.paymentStatus === 'paid') {
      throw new AppError(
        409,
        'PAYMENT_ALREADY_EXISTS',
        'This booking is already marked paid but has no verified payment record.'
      );
    }

    const existingSessionPayment = await payments.findByStripeSessionId(sessionId);

    if (existingSessionPayment) {
      throw new AppError(
        409,
        'PAYMENT_SESSION_CONFLICT',
        'This Stripe session was already used for a different booking.'
      );
    }

    let payment;

    try {
      payment = await payments.create({
        bookingId: verified.bookingId,
        serviceTitle: verified.booking.serviceTitle,
        customerName: verified.booking.customerName,
        customerEmail: verified.customerEmail,
        technicianName: verified.booking.technicianName,
        technicianEmail: verified.booking.technicianEmail,
        amount: verified.booking.finalAmount,
        currency: PAYMENT_CURRENCY,
        transactionId: session.payment_intent || sessionId,
        stripeSessionId: sessionId,
        paymentStatus: 'paid',
        paidAt: Number.isFinite(session.created)
          ? new Date(session.created * 1000)
          : new Date()
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const existingBookingPaymentAfterRace = await payments.findByBookingId(
        verified.bookingId
      );

      if (existingBookingPaymentAfterRace) {
        return handleExistingBookingPayment({
          payment: existingBookingPaymentAfterRace,
          verified,
          attemptedSessionId: sessionId
        });
      }

      const existingSessionPaymentAfterRace = await payments.findByStripeSessionId(sessionId);

      if (existingSessionPaymentAfterRace) {
        throw new AppError(
          409,
          'PAYMENT_SESSION_CONFLICT',
          'This Stripe session was already used for a different booking.'
        );
      }

      throw new AppError(
        409,
        'PAYMENT_CONFLICT',
        'Payment could not be recorded uniquely. Retry with the verified Stripe session.'
      );
    }

    const updatedBooking = await markBookingPaidAfterPayment(verified.bookingId);

    return { payment, booking: updatedBooking, alreadyFulfilled: false };
  };

  return {
    requireCustomer,
    fulfillPaidCheckoutSession,
    createCheckoutSession: async (req, res) => {
      const { user } = await requireCustomer(req);
      const input = parseInput(
        checkoutSessionInputSchema,
        req.body,
        'INVALID_CHECKOUT_INPUT',
        'Invalid checkout input.'
      );
      const booking = await bookings.findById(input.bookingId);

      if (!booking || String(booking.customerEmail) !== user.email) {
        throw new AppError(404, 'NOT_FOUND', 'Booking not found.');
      }

      if (booking.status !== 'completed' || booking.paymentStatus !== 'unpaid') {
        throw new AppError(
          409,
          'PAYMENT_NOT_ALLOWED',
          'Only an unpaid completed booking can be paid.'
        );
      }

      const existingPayment = await payments.findByBookingId(booking._id);

      if (existingPayment) {
        getStoredPaymentSessionId(existingPayment, {
          booking,
          bookingId: booking._id,
          customerEmail: booking.customerEmail
        });
        const updatedBooking = await markBookingPaidAfterPayment(booking._id);

        return sendSuccess(res, {
          message: 'Payment already recorded.',
          ...paymentResultResponse({
            payment: existingPayment,
            booking: updatedBooking,
            alreadyFulfilled: true
          })
        });
      }

      requireCheckoutClient(stripeClient);

      const amount = getAmountInCents(booking);
      const origin = getNormalizedOrigin(clientOrigin);

      if (!origin) {
        throw new AppError(
          503,
          'PAYMENT_REDIRECT_UNAVAILABLE',
          'Payment redirect is not configured.'
        );
      }

      let session;

      try {
        session = await stripeClient.checkout.sessions.create(
          {
            mode: 'payment',
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: PAYMENT_CURRENCY,
                  unit_amount: amount,
                  product_data: { name: booking.serviceTitle }
                }
              }
            ],
            success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/payment/cancel`,
            metadata: {
              bookingId: String(booking._id),
              customerEmail: user.email
            }
          },
          {
            idempotencyKey: `fixmate-checkout-${String(booking._id)}-${amount}`
          }
        );
      } catch {
        throw new AppError(
          502,
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'Unable to start checkout. Please try again.'
        );
      }

      if (!session?.id) {
        throw new AppError(
          502,
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'Unable to start checkout. Please try again.'
        );
      }

      return sendSuccess(res, {
        message: 'Checkout session created successfully.',
        checkoutUrl: session.url
      });
    },
    verifyPayment: async (req, res) => {
      const { user } = await requireCustomer(req);
      const query = parseInput(
        paymentVerificationQuerySchema,
        req.query,
        'INVALID_SESSION_ID',
        'Invalid Stripe session ID.'
      );
      const existingPayment = await payments.findByStripeSessionId(query.session_id);

      if (existingPayment) {
        const booking = await bookings.findById(existingPayment.bookingId);

        if (!booking || String(booking.customerEmail) !== user.email) {
          throw new AppError(404, 'NOT_FOUND', 'Booking not found.');
        }

        const result = await reconcileExistingPayment({
          payment: existingPayment,
          verified: {
            booking,
            bookingId: booking._id,
            customerEmail: booking.customerEmail
          },
          sessionId: query.session_id
        });

        return sendSuccess(res, {
          message: 'Payment verified successfully.',
          ...paymentResultResponse(result)
        });
      }

      requireCheckoutClient(stripeClient);

      let session;

      try {
        session = await stripeClient.checkout.sessions.retrieve(query.session_id);
      } catch {
        throw new AppError(
          502,
          'PAYMENT_PROVIDER_UNAVAILABLE',
          'Unable to verify payment. Please try again.'
        );
      }

      if (!session) {
        throw new AppError(404, 'PAYMENT_SESSION_NOT_FOUND', 'Stripe session not found.');
      }

      const result = await fulfillPaidCheckoutSession({
        session,
        expectedSessionId: query.session_id,
        expectedCustomerEmail: user.email
      });

      return sendSuccess(res, {
        message: 'Payment verified successfully.',
        ...paymentResultResponse(result)
      });
    },
    handleWebhookEvent: async (event) => {
      if (!event || typeof event.type !== 'string') {
        throw new AppError(400, 'INVALID_WEBHOOK_EVENT', 'Invalid webhook event.');
      }

      if (!SUPPORTED_WEBHOOK_EVENTS.has(event.type)) {
        return { received: true, ignored: true };
      }

      const session = event.data?.object;

      if (!session || session.object !== 'checkout.session') {
        throw new AppError(400, 'INVALID_WEBHOOK_EVENT', 'Invalid webhook event.');
      }

      if (session.payment_status !== 'paid') {
        return { received: true, ignored: true };
      }

      await fulfillPaidCheckoutSession({ session });

      return { received: true, ignored: false };
    }
  };
};

export const paymentController = createPaymentController();
