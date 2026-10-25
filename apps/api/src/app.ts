import Fastify, { LogController } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import { storefrontSchema, productSchema, quoteSchema } from '../../../packages/contracts/src/public.js';
import { storefront, publicProducts, quote, uuidPattern, type Item } from './catalog.js';
import { DomainError } from './errors.js';
import { adminRoutes } from './admin/routes.js';
import staticFiles from '@fastify/static';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

export async function buildApp(pool: Pool, options: {rateMax?: number; logger?: boolean;adminOrigin?:string;secureCookies?:boolean} = {}) {
  const app = Fastify({ logger: options.logger ?? false, logController: new LogController({disableRequestLogging:true}), trustProxy: false,
    bodyLimit: 16384, ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}, requestTimeout:10000 });
  await app.register(rateLimit, { max: options.rateMax ?? 120, timeWindow: '1 minute' });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & {validation?: unknown; statusCode?: number};
    const status = error instanceof DomainError ? error.statusCode : e.validation || e.statusCode === 400 ? 400 : e.statusCode === 429 ? 429 : e.statusCode === 413 ? 413 : e.statusCode === 415 ? 415 : 500;
    const code = error instanceof DomainError ? error.code : status === 400 ? 'INVALID_REQUEST' : status === 429 ? 'RATE_LIMITED' : status === 413 ? 'BODY_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'INTERNAL_ERROR';
    // Never log SQL, request bodies, cookies, contact data or connection strings.
    if (status >= 500) app.log.error({ code }, 'API request failed');
    reply.code(status).send({error:code});
  });
  app.setNotFoundHandler((_request,reply) => reply.code(404).send({error:'NOT_FOUND'}));
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store').header('Vary','Origin');
    reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const origin = request.headers.origin;
    if(request.url.split('?')[0]!.startsWith('/api/v1/admin/')) return;
    if(request.url.split('?')[0]!.startsWith('/admin/')) {
      if(origin&&origin!==(options.adminOrigin??'http://127.0.0.1:3000')) throw new DomainError('ADMIN_ORIGIN_REJECTED',403);
      return;
    }
    if (!origin) return;
    const slug = (request.params as {slug?: string}).slug;
    if (!slug) throw new DomainError('ORIGIN_NOT_ALLOWED',403);
    const store = await storefront(pool, slug);
    if (!store.allowed_origins.includes(origin)) throw new DomainError('ORIGIN_NOT_ALLOWED',403);
    reply.header('Access-Control-Allow-Origin',origin);
    if (request.method === 'OPTIONS') {
      if (!['GET','POST'].includes(String(request.headers['access-control-request-method'])) ||
        String(request.headers['access-control-request-headers'] ?? '').split(',').some(v => v.trim() && v.trim().toLowerCase() !== 'content-type')) {
        throw new DomainError('PREFLIGHT_NOT_ALLOWED',403);
      }
      reply.header('Access-Control-Allow-Methods','GET, POST').header('Access-Control-Allow-Headers','Content-Type');
    }
  });
  app.get('/health/live', async () => ({status:'ok'}));
  app.get('/health/ready', async (_request, reply) => {
    try {
      const result = await pool.query("SELECT name FROM schema_migrations WHERE name='003_admin.sql'");
      if (result.rowCount !== 1) return reply.code(503).send({status:'not_ready'});
      return {status:'ready'};
    } catch { return reply.code(503).send({status:'not_ready'}); }
  });
  const params = {type:'object',required:['slug'],additionalProperties:false,properties:{slug:{type:'string',pattern:'^[a-z0-9-]{1,80}$'}}};
  app.get<{Params:{slug:string}}>('/api/v1/storefronts/:slug', {schema:{params,response:{200:storefrontSchema}}}, async request => {
    const s = await storefront(pool,request.params.slug);
    return {id:s.id,slug:s.slug,domain:s.domain,name:s.name};
  });
  app.get<{Params:{slug:string}}>('/api/v1/storefronts/:slug/products', {schema:{params,response:{200:{type:'array',items:productSchema}}}}, async request => {
    const s = await storefront(pool,request.params.slug);
    return publicProducts(pool,s.id);
  });
  app.post<{Params:{slug:string};Body:{items:Item[]}}>('/api/v1/storefronts/:slug/quote', {schema:{params,
    body:{type:'object',additionalProperties:false,required:['items'],properties:{items:{type:'array',minItems:1,maxItems:50,items:{
      type:'object',additionalProperties:false,required:['productId','quantity'],properties:{productId:{type:'string',pattern:uuidPattern},quantity:{type:'integer',minimum:1,maximum:999}},
    }}}},response:{200:quoteSchema}}}, request => quote(pool,request.params.slug,request.body.items));
  app.options('/api/v1/storefronts/:slug/*', async (_request,reply) => reply.code(204).send());
  await adminRoutes(app,pool,{origin:options.adminOrigin??'http://127.0.0.1:3000',secureCookies:options.secureCookies??true});
  if(existsSync(resolve('dist/admin/index.html'))) {
    await app.register(staticFiles,{root:resolve('dist/admin'),prefix:'/admin/',decorateReply:false});
    app.get('/admin',(_req,reply)=>reply.redirect('/admin/'));
  }
  return app;
}
