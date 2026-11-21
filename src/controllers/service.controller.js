import { serviceRepository, userRepository } from '../repositories/index.js';
import { PUBLIC_SERVICE_FIELDS } from '../repositories/service.repository.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { pickAllowedFields } from '../utils/projections.js';

const PUBLIC_TECHNICIAN_FIELDS = Object.freeze(['name', 'image', 'area', 'bio']);

export const createServiceController = ({
  services = serviceRepository,
  users = userRepository
} = {}) => ({
  list: async (req, res) => {
    const result = await services.findPublicServices(req.query);

    return sendSuccess(res, {
      message: 'Services retrieved successfully.',
      ...result,
      items: result.items.map((service) =>
        pickAllowedFields(service, PUBLIC_SERVICE_FIELDS)
      )
    });
  },
  getById: async (req, res) => {
    const service = await services.findPublicById(req.params.id, {
      includeTechnicianEmail: true
    });
    const technician = await users.findPublicTechnicianByEmail(
      service.technicianEmail
    );
    const publicTechnician = Object.fromEntries(
      PUBLIC_TECHNICIAN_FIELDS.map((field) => [
        field,
        technician?.[field] ?? (field === 'name' ? service.technicianName : '')
      ])
    );

    return sendSuccess(res, {
      message: 'Service retrieved successfully.',
      service: {
        ...pickAllowedFields(service, PUBLIC_SERVICE_FIELDS),
        technician: publicTechnician
      }
    });
  }
});

export const serviceController = createServiceController();
