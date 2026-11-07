interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  CACHE: KVNamespace;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  WORKSPACE_PROVISIONING_KEY?: string;
  MAX_UPLOAD_BYTES?: string;
}
type Member = { user_id: string; business_id: string; role: string };
const QUOTA = 500 * 1024 * 1024;
const RETENTION_DAYS = 90;
const ALLOWED_ORIGINS = new Set(["https://app.twiga.co.ke", "https://twiga.co.ke", "https://www.twiga.co.ke"]);
const corsFor = (origin: string | null) => ({
  "access-control-allow-origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400",
  "vary": "Origin"
});
const response = (data: unknown, status = 200, origin: string | null = null) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsFor(origin), "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const id = () => crypto.randomUUID();
const iso = () => new Date().toISOString();
const expiry = () => new Date(Date.now() + RETENTION_DAYS * 86400000).toISOString();
const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150) || "file";

async function authenticate(req: Request, env: Env): Promise<{ userId: string; email: string } | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !env.SUPABASE_ANON_KEY) return null;
  const r = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: "Bearer " + token }
  });
  if (!r.ok) return null;
  const user = await r.json() as { id?: string; email?: string; email_confirmed_at?: string | null };
  return user.id && user.email && user.email_confirmed_at ? { userId: user.id, email: user.email.toLowerCase() } : null;
}
async function membership(env: Env, userId: string, businessId: string): Promise<Member | null> {
  const u = new URL(env.SUPABASE_URL + "/rest/v1/twiga_business_memberships");
  u.searchParams.set("select", "user_id,business_id,role");
  u.searchParams.set("user_id", "eq." + userId);
  u.searchParams.set("business_id", "eq." + businessId);
  u.searchParams.set("limit", "1");
  const r = await fetch(u, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY } });
  if (!r.ok) throw new Error("Membership verification unavailable");
  const rows = await r.json() as Member[];
  return rows[0] ?? null;
}
async function ensureUsage(env: Env, businessId: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO storage_usage(business_id,used_bytes,quota_bytes) VALUES(?,0,?)").bind(businessId, QUOTA).run();
}
async function reserve(env: Env, businessId: string, bytes: number) {
  await ensureUsage(env, businessId);
  const r = await env.DB.prepare("UPDATE storage_usage SET used_bytes=used_bytes+?,updated_at=? WHERE business_id=? AND used_bytes+?<=quota_bytes")
    .bind(bytes, iso(), businessId, bytes).run();
  return r.meta.changes === 1;
}
async function release(env: Env, businessId: string, bytes: number) {
  await env.DB.prepare("UPDATE storage_usage SET used_bytes=MAX(0,used_bytes-?),updated_at=? WHERE business_id=?")
    .bind(bytes, iso(), businessId).run();
}
async function audit(env: Env, businessId: string, actor: string, event: string, target?: string) {
  await env.DB.prepare("INSERT INTO audit_events(id,business_id,actor_user_id,event_type,target_id,created_at) VALUES(?,?,?,?,?,?)")
    .bind(id(), businessId, actor, event, target ?? null, iso()).run();
}
async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsFor(origin) });
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) return response({ error: "Origin not allowed" }, 403, origin);
  if (url.pathname === "/health") return response({ ok: true, service: "twiga-storage", time: iso() }, 200, origin);
  const auth = await authenticate(req, env);
  if (!auth) return response({ error: "Authentication required" }, 401, origin);

  // Workspace creation is the only route that does not require a pre-existing membership.
  if (req.method === "POST" && url.pathname === "/v1/workspaces") {
    if (!env.WORKSPACE_PROVISIONING_KEY || req.headers.get("x-twiga-provisioning-key") !== env.WORKSPACE_PROVISIONING_KEY) return response({ error: "Workspace provisioning is restricted to authorized setup operations" }, 403, origin);
    const body = await req.json() as { name?: string; customerId?: string };
    const name = String(body.name ?? "").trim().slice(0, 120);
    const customerId = String(body.customerId ?? "");
    if (!name || !/^[0-9a-f-]{36}$/i.test(customerId)) return response({ error: "Workspace name and existing TWIGA customerId are required" }, 400, origin);
    const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "content-type": "application/json", prefer: "return=minimal" };
    const customerUrl = new URL(env.SUPABASE_URL + "/rest/v1/twiga_customers");
    customerUrl.searchParams.set("select", "id,business_name,email,status,trial_ends_at");
    customerUrl.searchParams.set("id", "eq." + customerId);
    customerUrl.searchParams.set("limit", "1");
    const customerResponse = await fetch(customerUrl, { headers });
    if (!customerResponse.ok) return response({ error: "Could not verify TWIGA subscription account" }, 503, origin);
    const customers = await customerResponse.json() as Array<{id:string;business_name:string;email:string|null;status:string;trial_ends_at:string|null}>;
    const customer = customers[0];
    if (!customer || !customer.email || customer.email.toLowerCase() !== auth.email) return response({ error: "The signed-in verified Google email must match the email on the existing TWIGA subscription" }, 403, origin);
    const subscriptionsUrl = new URL(env.SUPABASE_URL + "/rest/v1/twiga_subscriptions");
    subscriptionsUrl.searchParams.set("select", "status,ends_at");
    subscriptionsUrl.searchParams.set("customer_id", "eq." + customerId);
    subscriptionsUrl.searchParams.set("order", "ends_at.desc");
    subscriptionsUrl.searchParams.set("limit", "1");
    const subscriptionsResponse = await fetch(subscriptionsUrl, { headers });
    if (!subscriptionsResponse.ok) return response({ error: "Could not verify subscription status" }, 503, origin);
    const subscriptions = await subscriptionsResponse.json() as Array<{status:string;ends_at:string|null}>;
    const now = Date.now();
    const validTrial = customer.status === "trial" && !!customer.trial_ends_at && new Date(customer.trial_ends_at).getTime() > now;
    const validPaid = customer.status === "active" && subscriptions[0]?.status === "active" && !!subscriptions[0].ends_at && new Date(subscriptions[0].ends_at).getTime() > now;
    if (!validTrial && !validPaid) return response({ error: "An active trial or paid TWIGA subscription is required before creating a workspace" }, 403, origin);
    const existingUrl = new URL(env.SUPABASE_URL + "/rest/v1/twiga_business_workspaces");
    existingUrl.searchParams.set("select", "id,name,created_by,status");
    existingUrl.searchParams.set("legacy_customer_id", "eq." + customerId);
    existingUrl.searchParams.set("limit", "1");
    const existingResponse = await fetch(existingUrl, { headers });
    if (!existingResponse.ok) return response({ error: "Could not check existing workspace mapping" }, 503, origin);
    const existing = (await existingResponse.json()) as Array<{id:string;name:string;created_by:string;status:string}>;
    if (existing[0]) {
      if (existing[0].created_by !== auth.userId) return response({ error: "This subscription is already linked to another account. Contact TWIGA support." }, 409, origin);
      return response({ businessId: existing[0].id, name: existing[0].name, quotaBytes: QUOTA, retentionDays: RETENTION_DAYS }, 200, origin);
    }
    const businessId = id();
    const r = await fetch(env.SUPABASE_URL + "/rest/v1/twiga_business_workspaces", { method: "POST", headers, body: JSON.stringify({ id: businessId, name, created_by: auth.userId, legacy_customer_id: customerId }) });
    if (!r.ok) return response({ error: "Could not create workspace" }, 502, origin);
    const m = await fetch(env.SUPABASE_URL + "/rest/v1/twiga_business_memberships", { method: "POST", headers, body: JSON.stringify({ business_id: businessId, user_id: auth.userId, role: "owner" }) });
    if (!m.ok) {
      await fetch(env.SUPABASE_URL + "/rest/v1/twiga_business_workspaces?id=eq." + businessId, { method: "DELETE", headers });
      return response({ error: "Workspace owner setup failed; retry or contact support" }, 502, origin);
    }
    await ensureUsage(env, businessId);
    return response({ businessId, name, quotaBytes: QUOTA, retentionDays: RETENTION_DAYS }, 201, origin);
  }

  const businessId = url.searchParams.get("businessId") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(businessId)) return response({ error: "A valid businessId is required" }, 400, origin);
  const member = await membership(env, auth.userId, businessId);
  if (!member) return response({ error: "You do not have access to this business" }, 403, origin);
  const workspaceUrl = new URL(env.SUPABASE_URL + "/rest/v1/twiga_business_workspaces");
  workspaceUrl.searchParams.set("select", "status");
  workspaceUrl.searchParams.set("id", "eq." + businessId);
  workspaceUrl.searchParams.set("limit", "1");
  const workspaceResponse = await fetch(workspaceUrl, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY } });
  if (!workspaceResponse.ok) return response({ error: "Workspace status verification unavailable" }, 503, origin);
  const workspaceRows = await workspaceResponse.json() as Array<{status:string}>;
  if (!workspaceRows[0] || workspaceRows[0].status !== "active") return response({ error: "Workspace is not active" }, 403, origin);
  const canWrite = ["owner", "admin", "manager"].includes(member.role);

  if (req.method === "GET" && url.pathname === "/v1/storage/usage") {
    await ensureUsage(env, businessId);
    const row = await env.DB.prepare("SELECT used_bytes,quota_bytes FROM storage_usage WHERE business_id=?").bind(businessId).first<{used_bytes:number;quota_bytes:number}>();
    return response({ usedBytes: row?.used_bytes ?? 0, quotaBytes: row?.quota_bytes ?? QUOTA, availableBytes: Math.max(0,(row?.quota_bytes ?? QUOTA)-(row?.used_bytes ?? 0)), retentionDays: RETENTION_DAYS });
  }

  if (url.pathname === "/v1/records" && req.method === "POST") {
    if (!canWrite) return response({ error: "Read-only membership" }, 403);
    const declaredLength = Number(req.headers.get("content-length") ?? 0);
    if (declaredLength > 1100000) return response({ error: "Record request is too large" }, 413, origin);
    const body = await req.json() as { type?: string; data?: unknown };
    const type = String(body.type ?? "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,59}$/.test(type) || body.data === undefined) return response({ error: "Valid type and data are required" }, 400);
    const payload = JSON.stringify(body.data);
    const bytes = new TextEncoder().encode(payload).byteLength;
    if (bytes > 1024 * 1024) return response({ error: "A record cannot exceed 1 MB" }, 413);
    if (!await reserve(env, businessId, bytes)) return response({ error: "Storage limit reached", quotaBytes: QUOTA }, 413);
    const recordId = id(), created = iso(), expires = expiry();
    try {
      await env.DB.prepare("INSERT INTO records(id,business_id,record_type,payload,size_bytes,created_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?)")
        .bind(recordId,businessId,type,payload,bytes,created,expires,auth.userId).run();
      try { await audit(env,businessId,auth.userId,"record.created",recordId); } catch (e) { console.error("Audit write failed",e); }
    } catch (e) { await release(env,businessId,bytes); throw e; }
    return response({ id: recordId, type, createdAt: created, expiresAt: expires, sizeBytes: bytes }, 201);
  }

  if (url.pathname === "/v1/records" && req.method === "GET") {
    const type = url.searchParams.get("type");
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
    const rows = type
      ? await env.DB.prepare("SELECT id,record_type,payload,size_bytes,created_at,expires_at FROM records WHERE business_id=? AND record_type=? AND expires_at>? ORDER BY created_at DESC LIMIT ?").bind(businessId,type,iso(),limit).all()
      : await env.DB.prepare("SELECT id,record_type,payload,size_bytes,created_at,expires_at FROM records WHERE business_id=? AND expires_at>? ORDER BY created_at DESC LIMIT ?").bind(businessId,iso(),limit).all();
    return response({ records: rows.results });
  }

  if (url.pathname === "/v1/records" && req.method === "DELETE") {
    if (!canWrite) return response({ error: "Read-only membership" }, 403);
    const recordId = url.searchParams.get("id");
    if (!recordId) return response({ error: "Record id required" }, 400);
    const row = await env.DB.prepare("SELECT size_bytes FROM records WHERE id=? AND business_id=? AND expires_at>?").bind(recordId,businessId,iso()).first<{size_bytes:number}>();
    if (!row) return response({ error: "Record not found" }, 404);
    const deleted = await env.DB.prepare("DELETE FROM records WHERE id=? AND business_id=?").bind(recordId,businessId).run();
    if (!deleted.meta.changes) return response({ error: "Record not found" }, 404);
    await release(env,businessId,row.size_bytes);
    try { await audit(env,businessId,auth.userId,"record.deleted",recordId); } catch (e) { console.error("Audit write failed",e); }
    return response({ ok: true });
  }

  if (url.pathname === "/v1/files" && req.method === "POST") {
    if (!canWrite) return response({ error: "Read-only membership" }, 403);
    const max = Number(env.MAX_UPLOAD_BYTES ?? 26214400);
    const declaredLength = Number(req.headers.get("content-length") ?? 0);
    if (declaredLength > max + 1048576) return response({ error: "Upload request is too large" }, 413, origin);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return response({ error: "Multipart field 'file' is required" }, 400);
    if (file.size < 1 || file.size > max) return response({ error: "File must be between 1 byte and " + max + " bytes" }, 413);
    if (!await reserve(env,businessId,file.size)) return response({ error: "500 MB business storage limit reached" }, 413);
    const objectId=id(), created=iso(), expires=expiry(), key=businessId+"/"+objectId+"/"+safeName(file.name);
    try {
      await env.FILES.put(key,file.stream(),{ httpMetadata:{ contentType:file.type || "application/octet-stream" }, customMetadata:{ businessId, objectId, expiresAt:expires } });
      await env.DB.prepare("INSERT INTO objects(id,business_id,object_key,filename,content_type,size_bytes,created_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(objectId,businessId,key,safeName(file.name),file.type || "application/octet-stream",file.size,created,expires,auth.userId).run();
      try { await audit(env,businessId,auth.userId,"file.uploaded",objectId); } catch (e) { console.error("Audit write failed",e); }
    } catch(e) { await env.FILES.delete(key); await release(env,businessId,file.size); throw e; }
    return response({ id:objectId, filename:safeName(file.name), sizeBytes:file.size, createdAt:created, expiresAt:expires },201);
  }

  if (url.pathname === "/v1/files" && req.method === "GET") {
    const fileId=url.searchParams.get("id");
    if (!fileId) {
      const rows=await env.DB.prepare("SELECT id,filename,content_type,size_bytes,created_at,expires_at FROM objects WHERE business_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 100").bind(businessId,iso()).all();
      return response({ files:rows.results });
    }
    const row=await env.DB.prepare("SELECT object_key,filename,content_type,size_bytes FROM objects WHERE id=? AND business_id=? AND expires_at>?").bind(fileId,businessId,iso()).first<{object_key:string;filename:string;content_type:string;size_bytes:number}>();
    if(!row) return response({error:"File not found"},404);
    const object=await env.FILES.get(row.object_key);
    if(!object) return response({error:"File content missing"},404);
    const headers=new Headers(corsFor(origin));
    headers.set("content-type",/^[\w.+-]+\/[\w.+-]+$/.test(row.content_type) ? row.content_type : "application/octet-stream");
    headers.set("content-length",String(row.size_bytes));
    headers.set("content-disposition",'attachment; filename="'+safeName(row.filename)+'"');
    headers.set("cache-control","private, no-store");
    return new Response(object.body,{headers});
  }

  if (url.pathname === "/v1/files" && req.method === "DELETE") {
    if (!canWrite) return response({ error: "Read-only membership" },403);
    const fileId=url.searchParams.get("id");
    if(!fileId) return response({error:"File id required"},400);
    const row=await env.DB.prepare("SELECT object_key,size_bytes FROM objects WHERE id=? AND business_id=?").bind(fileId,businessId).first<{object_key:string;size_bytes:number}>();
    if(!row) return response({error:"File not found"},404);
    await env.FILES.delete(row.object_key);
    const deleted = await env.DB.prepare("DELETE FROM objects WHERE id=? AND business_id=?").bind(fileId,businessId).run();
    if (!deleted.meta.changes) return response({ error: "File not found" }, 404);
    await release(env,businessId,row.size_bytes);
    try { await audit(env,businessId,auth.userId,"file.deleted",fileId); } catch (e) { console.error("Audit write failed",e); }
    return response({ok:true});
  }
  return response({error:"Route not found"},404);
}

export default {
  fetch(req: Request, env: Env) {
    return handle(req,env).catch((e: unknown) => {
      console.error("TWIGA worker error",e);
      return response({error:"Internal server error"},500);
    });
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async()=>{
      const runId=id(), started=iso();
      await env.DB.prepare("INSERT INTO cleanup_runs(id,started_at,status) VALUES(?,?,'running')").bind(runId,started).run();
      let recordsDeleted=0, objectsDeleted=0, bytesReleased=0;
      // Bounded batches keep scheduled invocations short and make retries safe.
      for(let batch=0;batch<20;batch++){
        const rows=await env.DB.prepare("SELECT id,business_id,size_bytes FROM records WHERE expires_at<=? LIMIT 200").bind(iso()).all<{id:string;business_id:string;size_bytes:number}>();
        if(!rows.results.length) break;
        for(const r of rows.results){
          const d=await env.DB.prepare("DELETE FROM records WHERE id=? AND expires_at<=?").bind(r.id,iso()).run();
          if(d.meta.changes){await release(env,r.business_id,r.size_bytes);recordsDeleted++;bytesReleased+=r.size_bytes;}
        }
      }
      for(let batch=0;batch<20;batch++){
        const rows=await env.DB.prepare("SELECT id,business_id,object_key,size_bytes FROM objects WHERE expires_at<=? LIMIT 100").bind(iso()).all<{id:string;business_id:string;object_key:string;size_bytes:number}>();
        if(!rows.results.length) break;
        for(const r of rows.results){
          await env.FILES.delete(r.object_key);
          const d=await env.DB.prepare("DELETE FROM objects WHERE id=? AND expires_at<=?").bind(r.id,iso()).run();
          if(d.meta.changes){await release(env,r.business_id,r.size_bytes);objectsDeleted++;bytesReleased+=r.size_bytes;}
        }
      }
      await env.DB.prepare("UPDATE cleanup_runs SET finished_at=?,records_deleted=?,objects_deleted=?,bytes_released=?,status='complete' WHERE id=?")
        .bind(iso(),recordsDeleted,objectsDeleted,bytesReleased,runId).run();
    })());
  }
};
