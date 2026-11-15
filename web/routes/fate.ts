import { defineHandler } from 'void';
import { handleFateRequest } from '../src/server/routes.ts';

const handle = defineHandler((context) =>
  handleFateRequest(context.req.raw, context.env, context.get('__voidAuth')),
);

export const GET = handle;
export const POST = handle;
