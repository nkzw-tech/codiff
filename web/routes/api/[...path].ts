import { defineHandler } from 'void';
import { handleApiRequest } from '../../src/server/routes.ts';

const handle = defineHandler((context) =>
  handleApiRequest(context.req.raw, context.env, context.get('__voidAuth')),
);

export const GET = handle;
export const POST = handle;
