// Outlook message/draft IDs exceed Fastify's default 100-character route limit.
// Retain a finite limit while allowing provider-issued opaque identifiers.
export const serverOptions = { routerOptions: { maxParamLength: 2048 } };
