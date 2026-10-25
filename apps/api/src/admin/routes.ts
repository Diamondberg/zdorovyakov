import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { Pool } from 'pg';
import { DomainError } from '../errors.js';
import { uuidPattern } from '../catalog.js';
import { savePromotion } from '../promotions.js';
import { csrfFor,digest,login,owner,requireCsrf,session,type Actor } from './auth.js';
import * as service from './service.js';
import { transaction } from '../../../../db/migrate.js';

declare module 'fastify' {
  interface FastifyRequest {adminActor:Actor|null;adminSessionToken:string|null}
  interface FastifyContextConfig {adminPublic?:boolean;ownerOnly?:boolean}
}
const str=(max=200)=>({type:'string',minLength:1,maxLength:max});
const money={type:'integer',minimum:0,maximum:100000000};
const version={type:'integer',minimum:1};
const obj=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',additionalProperties:false,properties,required});
const params=obj({id:{type:'string',pattern:uuidPattern}},['id']);
const searchQuery=obj({search:{type:'string',maxLength:200},offset:{type:'string',pattern:'^[0-9]{1,6}$'},processing:str(30),payment:str(30),delivery:str(30),attention:{type:'string',enum:['awaiting_payment','ready_to_ship']}});
const email={type:'string',maxLength:254,pattern:'^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'};
const recipient=obj({firstName:str(100),lastName:str(100),phone:str(30),email},['firstName','lastName','phone','email']);
const shipping=obj({country:str(100),city:str(150),address:str(500),postalCode:{type:'string',maxLength:20}},['country','city','address']);
const promoProperties={name:str(200),startsAt:{type:'string',format:'date-time'},endsAt:{type:'string',format:'date-time'},active:{type:'boolean'},
  productIds:{type:'array',minItems:1,maxItems:50,uniqueItems:true,items:{type:'string',pattern:uuidPattern}},
  rules:{type:'array',minItems:1,maxItems:20,items:obj({minQuantity:{type:'integer',minimum:1,maximum:999},discountBps:{type:'integer',minimum:0,maximum:10000}},['minQuantity','discountBps'])}};

export async function adminRoutes(app:FastifyInstance,pool:Pool,options:{origin:string;secureCookies:boolean}) {
  const origin=new URL(options.origin).origin;
  const cookieName=options.secureCookies?'__Host-zd-admin':'zd-admin-dev';
  await app.register(cookie);
  app.decorateRequest('adminActor',null);app.decorateRequest('adminSessionToken',null);
  await app.register(async api=>{
    api.addHook('onRequest',async(req)=>{
      const unsafe=!['GET','HEAD','OPTIONS'].includes(req.method);
      if((req.headers.origin&&req.headers.origin!==origin)||(unsafe&&req.headers.origin!==origin)) throw new DomainError('ADMIN_ORIGIN_REJECTED',403);
      if(req.routeOptions.config.adminPublic) return;
      const token=req.cookies[cookieName];req.adminActor=await session(pool,token);req.adminSessionToken=token!;
      if(unsafe) requireCsrf(req,token!);
      if(req.routeOptions.config.ownerOnly) owner(req.adminActor);
    });
    api.post<{Body:{email:string;password:string}}>('/auth/login',{config:{adminPublic:true},schema:{body:obj({email,password:str(256)},['email','password'])}},async(req,reply)=>{
      const result=await login(pool,req.body.email,req.body.password,req.ip,req.cookies[cookieName]);
      reply.setCookie(cookieName,result.token,{path:'/',httpOnly:true,secure:options.secureCookies,sameSite:'strict',maxAge:8*60*60});
      return {actor:result.actor,csrfToken:result.csrfToken};
    });
    api.get('/auth/me',async req=>({actor:req.adminActor,csrfToken:csrfFor(req.adminSessionToken!)}));
    api.post('/auth/logout',async(req,reply)=>{
      await transaction(pool,async db=>{
        await db.query('UPDATE admin_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[digest(req.adminSessionToken!)]);
        await service.audit(db,req.adminActor!,'admin.logout','admin',req.adminActor!.id);
      });
      reply.clearCookie(cookieName,{path:'/',httpOnly:true,secure:options.secureCookies,sameSite:'strict'});return {ok:true};
    });
    api.get('/summary',()=>service.summary(pool));
    api.get<{Querystring:{search?:string;processing?:string;payment?:string;delivery?:string;attention?:string;offset?:string}}>('/orders',{schema:{querystring:searchQuery}},req=>service.listOrders(pool,{...req.query,offset:Number(req.query.offset??0)}));
    api.get<{Params:{id:string}}>('/orders/:id',{schema:{params}},req=>service.orderDetail(pool,req.params.id));
    api.patch<{Params:{id:string};Body:Parameters<typeof service.editOrder>[3]}>('/orders/:id',{schema:{params,body:obj({version,recipient,shipping,shippingMinor:money,carrier:str(100),trackingNumber:str(100)},['version'])}},req=>service.editOrder(pool,req.adminActor!,req.params.id,req.body));
    api.post<{Params:{id:string};Body:Parameters<typeof service.changeStatus>[3]}>('/orders/:id/status',{schema:{params,body:obj({version,kind:{type:'string',enum:['processing','payment','delivery']},value:str(30),confirm:{type:'boolean'},amountMinor:money},['version','kind','value'])}},req=>service.changeStatus(pool,req.adminActor!,req.params.id,req.body));
    api.post<{Params:{id:string};Body:{body:string}}>('/orders/:id/comments',{schema:{params,body:obj({body:str(2000)},['body'])}},req=>service.commentOrder(pool,req.adminActor!,req.params.id,req.body.body));
    api.get<{Querystring:{search?:string;offset?:string}}>('/customers',{schema:{querystring:obj({search:{type:'string',maxLength:200},offset:{type:'string',pattern:'^[0-9]{1,6}$'}})}},req=>service.listCustomers(pool,req.query.search,Number(req.query.offset??0)));
    api.get<{Params:{id:string}}>('/customers/:id',{schema:{params}},req=>service.customerDetail(pool,req.params.id));
    api.patch<{Params:{id:string};Body:Parameters<typeof service.editCustomer>[3]}>('/customers/:id',{schema:{params,body:obj({version,firstName:str(100),lastName:str(100),phone:str(30),email,notes:{type:'string',maxLength:2000},address:obj({country:str(100),region:str(150),city:str(150),postalCode:{type:'string',maxLength:20},address:str(500),pickupPoint:str(200)},['country','city'])},['version'])}},req=>service.editCustomer(pool,req.adminActor!,req.params.id,req.body));
    api.get('/products',async req=>{
      const rows=await pool.query('SELECT id,sku,name,retail_price_minor,purchase_price_minor,active,version FROM products ORDER BY sku');
      return rows.rows.map(({purchase_price_minor,...p})=>req.adminActor!.role==='owner'?{...p,purchase_price_minor}:p);
    });
    api.patch<{Params:{id:string};Body:Parameters<typeof service.editPrice>[3]}>('/products/:id/price',{config:{ownerOnly:true},schema:{params,body:obj({version,retailPriceMinor:money,purchasePriceMinor:money},['version','retailPriceMinor','purchasePriceMinor'])}},req=>service.editPrice(pool,req.adminActor!,req.params.id,req.body));
    api.get('/promotions',async()=>{
      const result=await pool.query(`SELECT p.*,coalesce((SELECT json_agg(pp.product_id) FROM promotion_products pp WHERE pp.promotion_id=p.id),'[]') AS product_ids,
        coalesce((SELECT json_agg(json_build_object('minQuantity',r.min_quantity,'discountBps',r.discount_bps) ORDER BY min_quantity) FROM promotion_rules r WHERE r.promotion_id=p.id),'[]') AS rules FROM promotions p ORDER BY starts_at DESC`);return result.rows;
    });
    type PromoBody={version?:number;name:string;startsAt:string;endsAt:string;active:boolean;productIds:string[];rules:{minQuantity:number;discountBps:number}[]};
    api.post<{Body:PromoBody}>('/promotions',{config:{ownerOnly:true},schema:{body:obj(promoProperties,Object.keys(promoProperties))}},async req=>({id:await savePromotion(pool,{...req.body,startsAt:new Date(req.body.startsAt),endsAt:new Date(req.body.endsAt)},{actorId:req.adminActor!.id})}));
    api.put<{Params:{id:string};Body:PromoBody}>('/promotions/:id',{config:{ownerOnly:true},schema:{params,body:obj({...promoProperties,version},[...Object.keys(promoProperties),'version'])}},async req=>({id:await savePromotion(pool,{...req.body,id:req.params.id,startsAt:new Date(req.body.startsAt),endsAt:new Date(req.body.endsAt)},{actorId:req.adminActor!.id,expectedVersion:req.body.version})}));
    api.get<{Querystring:{offset?:string}}>('/audit',{config:{ownerOnly:true},schema:{querystring:obj({offset:{type:'string',pattern:'^[0-9]{1,6}$'}})}},async req=>{
      const result=await pool.query(`SELECT l.id,l.action,l.entity_type,l.entity_id,l.redacted_changes,l.created_at,a.email AS actor FROM audit_logs l LEFT JOIN admin_users a ON a.id=l.admin_id ORDER BY l.created_at DESC,l.id LIMIT 50 OFFSET $1`,[Number(req.query.offset??0)]);return result.rows;
    });
  },{prefix:'/api/v1/admin'});
}
