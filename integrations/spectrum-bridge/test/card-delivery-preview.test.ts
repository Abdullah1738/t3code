import { expect, test, setSystemTime } from "bun:test";
import { cardPreviewImage } from "../src/card-preview.ts";
import { liveCardChatsConfig } from "../src/config.ts";
import { Sendblue } from "../src/sendblue.ts";
import { sbTransport } from "../src/sb-transport.ts";
import { Store } from "../src/store.ts";
import { Delivery, RETRY_WINDOW } from "../src/delivery.ts";
import { cardDeliveryOptions, observedLine } from "../src/sb-main.ts";

const url = "https://mac.tailnet.ts.net:18400/delivery-noon-fgbcnno52e6n0ka/";
const json = (body: unknown) => Response.json(body);

function continuationFixture(live = false) {
  const store = new Store(":memory:");
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let uploads = 0;
  let failUpload = false;
  let loseResponse = false;
  let status = "DELIVERED";
  let peer = "dm:+15555550002";
  let originalUrl = url;
  let session: string | undefined = "388250ee-8227-4a76-8bee-7470d7606c28";
  const updates = new Map<string, string>();
  const line = new Sendblue({ keyId: "test", secret: "test", number: "+15555550001", fetch: (async (input, init) => {
    const target = String(input);
    if (target.startsWith(url)) return target.endsWith(".png")
      ? new Response("stage bytes", { headers: { "content-type": "image/png" } })
      : new Response('<meta property="og:image" content="preview.png">', { headers: { "content-type": "text/html" } });
    const path = new URL(target).pathname;
    if (path === "/api/upload-file") {
      uploads++;
      if (failUpload) throw new Error("upload unavailable");
      return json({ media_url: `https://cdn.example/stage-${uploads}.png` });
    }
    if (init?.method === "GET") return json({ message_handle: "original", is_outbound: true, number: peer.slice(3),
      status, app_card: { url: originalUrl, layout: { caption: "Delivery tracking" }, sessionIdentifier: session } });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ path, body });
    if (path === "/api/send-message") return json({ message_handle: "original" });
    const key = String(body.idempotency_key);
    if (!updates.has(key)) updates.set(key, `update-${updates.size + 1}`);
    if (loseResponse) { loseResponse = false; throw new Error("response lost after accept"); }
    return json({ message_handle: updates.get(key) });
  }) as typeof fetch });
  const observed = observedLine(line, { synchronized: true, lastEventAt: 0 });
  const transport = sbTransport(observed, "dm:+15555550002", store, undefined,
    cardDeliveryOptions(observed, live, lineFetch as typeof fetch));
  // Use the same intercepted provider and private-page fetch for preview preparation.
  async function lineFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (String(input).startsWith(url)) return String(input).endsWith(".png")
      ? new Response("stage bytes", { headers: { "content-type": "image/png" } })
      : new Response('<meta property="og:image" content="preview.png">', { headers: { "content-type": "text/html" } });
    throw new Error("Unexpected preview fetch");
  }
  const delivery = new Delivery(store, transport, { projectScope: "test", enabled: () => true, chatGuid: () => peer });
  const enqueue = (id: string, updateOf?: string) => store.enqueue({ id, kind: "conversation", text: "",
    app: { url, caption: "Delivery tracking", ...(updateOf ? { updateOf, previewPage: url + "stages/preparing/" } : {}) } });
  enqueue("placement");
  return { store, line: observed, transport, delivery, requests, updates, enqueue, uploads: () => uploads,
    failUpload: (value: boolean) => { failUpload = value; }, loseResponse: () => { loseResponse = true; },
    original: (change: { status?: string; peer?: string; url?: string; noSession?: boolean }) => {
      status = change.status ?? status; peer = change.peer ?? peer; originalUrl = change.url ?? originalUrl;
      if (change.noSession) session = undefined;
    } };
}

test("a stage uploads a fresh static picture in the original session, and repeats send nothing", async () => {
  const f = continuationFixture();
  try {
    await f.delivery.tick();
    f.enqueue("preparing", "placement");
    await f.delivery.tick();
    f.enqueue("preparing", "placement");
    await f.delivery.tick();
    expect(f.uploads()).toBe(2);
    expect(f.requests.map(r => r.path)).toEqual(["/api/send-message", "/api/messages/original/update-app-card"]);
    expect(f.requests[1]!.body).toMatchObject({ url, interactive: false,
      layout: { imageUrl: "https://cdn.example/stage-2.png" } });
    expect(f.store.get<{ handle: string; sessionIdentifier: string }>("app-session:placement")).toEqual({ handle: "original", sessionIdentifier: "388250ee-8227-4a76-8bee-7470d7606c28" });
  } finally { f.store.close(); }
});

test("the production live-card configuration still uploads a static image for continuations", async () => {
  const f = continuationFixture(true);
  try {
    await f.delivery.tick();
    expect(f.uploads()).toBe(0);
    f.enqueue("preparing", "placement");
    await f.delivery.tick();
    expect(f.uploads()).toBe(1);
    expect(f.requests[1]).toMatchObject({path:"/api/messages/original/update-app-card",body:{interactive:false,
      layout:{imageUrl:"https://cdn.example/stage-1.png"}}});
  } finally {f.store.close();}
});

test("stage upload failure is known unsent and retryable; a lost continuation response reuses its image and provider key", async () => {
  const f = continuationFixture();
  try {
    await f.delivery.tick();
    f.enqueue("preparing", "placement");
    f.failUpload(true);
    await f.delivery.tick();
    expect(f.store.getOperation("preparing")?.state).toBe("pending");
    expect(f.store.get<boolean>("sendAmbiguous:preparing")).toBe(false);
    expect(f.requests).toHaveLength(1);
    f.failUpload(false);
    f.loseResponse();
    setSystemTime(f.store.get<number>("retry:preparing")!);
    await f.delivery.tick();
    expect(f.store.getOperation("preparing")?.state).toBe("pending");
    const uploaded = f.uploads();
    setSystemTime(f.store.get<number>("retry:preparing")!);
    await f.delivery.tick();
    expect(f.uploads()).toBe(uploaded);
    expect(f.requests[1]).toEqual(f.requests[2]);
    expect(f.updates.size).toBe(1);
    expect(f.store.getOperation("preparing")?.state).toBe("sent");
  } finally { setSystemTime(); f.store.close(); }
});

for (const invalid of [{ status: "QUEUED" }, { status: "ERROR" }, { url: "https://other.example/" }, { noSession: true }]) {
  test(`a continuation never creates a fresh card when its original is unusable: ${JSON.stringify(invalid)}`, async () => {
    const f = continuationFixture();
    try {
      await f.delivery.tick(); f.original(invalid); f.enqueue("preparing", "placement");
      await f.delivery.tick();
      expect(f.requests).toHaveLength(1);
      expect(f.uploads()).toBe(1);
    } finally { f.store.close(); }
  });
}

test("a newer stage cancels a pending older continuation before it can overwrite the new picture", async () => {
  const f = continuationFixture();
  try {
    await f.delivery.tick();
    f.enqueue("preparing", "placement");
    const prepared = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    const transport = sbTransport(f.line, "dm:+15555550002", f.store, undefined, { static: true,
      previewImage: () => { entered.resolve(); return prepared.promise; } });
    const delivery = new Delivery(f.store, transport, { projectScope: "test", enabled: () => true, chatGuid: () => "dm:+15555550002" });
    const tick = delivery.tick();
    await entered.promise;
    f.enqueue("delivered", "placement");
    prepared.resolve("https://cdn.example/old.png");
    await tick;
    expect(f.store.getOperation("preparing")?.state).toBe("cancelled");
    expect(f.requests).toHaveLength(1);
    await f.delivery.tick();
    expect(f.requests).toHaveLength(2);
    expect(f.store.getOperation("delivered")?.state).toBe("sent");
  } finally { f.store.close(); }
});

test("owner delivery card has a static image layout with a private tap-through; retry sends once", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const media = "https://media.example/preview.png";
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    if (target === url) return new Response('<meta property="og:image" content="preview.png">', { headers: { "content-type": "text/html" } });
    if (target === url + "preview.png") return new Response(bytes, { headers: { "content-type": "image/png" } });
    const path = new URL(target).pathname;
    if (path === "/api/upload-file") {
      const file = (init!.body as FormData).get("file") as File;
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
      requests.push({ path, body: { name: file.name, type: file.type } });
      return json({ media_url: media });
    }
    const body: unknown = JSON.parse(init!.body as string);
    requests.push({ path, body });
    return json({ message_handle: "accepted" });
  }) as unknown as typeof fetch;
  const line = new Sendblue({ keyId: "test", secret: "test", number: "+15555550001", fetch: fetchFn,
    cardApp: { appName: "Robob Cards", extensionBundleId: "com.abdullah.robob.cards.MessagesExtension", teamId: "HVG39427R3" } });
  const store = new Store(":memory:");
  try {
    const transport = sbTransport(line, "dm:+15555550002", store, undefined,
      liveCardChatsConfig(undefined).includes("owner") ? {} : { static: true, previewImage: cardPreviewImage(file => line.upload(file), fetchFn) });
    store.enqueue({ id: "app:delivery-test", kind: "conversation", text: "", app: { url, caption: "Delivery tracking", summary: "Open your order" } });
    const delivery = new Delivery(store, transport, {projectScope: "test", enabled: () => true, chatGuid: () => "dm:+15555550002"});
    await delivery.tick();
    await delivery.tick();
    expect(store.getOperation("app:delivery-test")?.state).toBe("sent");
    expect(requests).toEqual([
      { path: "/api/upload-file", body: { name: "preview.png", type: "image/png" } },
      { path: "/api/send-message", body: { number: "+15555550002", from_number: "+15555550001", app_card: {
        appName: "Robob Cards", extensionBundleId: "com.abdullah.robob.cards.MessagesExtension", teamId: "HVG39427R3",
        url, interactive: false, layout: { caption: "Delivery tracking", summary: "Open your order", imageUrl: media },
      } } },
    ]);
  } finally { store.close(); }
});

test("live extension bubbles remain an explicit opt-in", () => {
  expect(liveCardChatsConfig(undefined)).toEqual([]);
  expect(liveCardChatsConfig(["owner"])).toEqual(["owner"]);
});

for (const change of ["cancelled", "rotated", "disabled", "destination", "readiness", "expired"] as const) {
  test(`preview preparation cannot send after dispatch guard changes: ${change}`, async () => {
    const store = new Store(":memory:");
    const entered = Promise.withResolvers<void>();
    const preview = Promise.withResolvers<string>();
    let enabled = true;
    let destination = "dm:+15555550002";
    let ready = true;
    let sends = 0;
    const line = new Sendblue({ keyId: "test", secret: "test", number: "+15555550001", fetch: (async () => {
      sends++;
      return json({ message_handle: "must-not-send" });
    }) as unknown as typeof fetch });
    const transport = sbTransport(line, "dm:+15555550002", store, undefined, {
      static: true, previewImage: async () => { entered.resolve(); return preview.promise; },
    });
    store.set("route", {id: "session", generation: 1});
    store.enqueue({id: "card", kind: "conversation", text: "", sessionId: "session", generation: 1, app: {url, caption: "Delivery tracking"}});
    store.set("firstAttempt:card", Date.now());
    store.set("sendAmbiguous:card", false);
    const delivery = new Delivery(store, transport, {projectScope: "test", enabled: () => enabled, chatGuid: () => destination,
      beforeSend: async () => ready ? "send" : "wait"});
    try {
      const ticking = delivery.tick();
      await entered.promise;
      if (change === "cancelled") store.outboxState("card", "cancelled");
      if (change === "rotated") store.set("route", {id: "session", generation: 2});
      if (change === "disabled") enabled = false;
      if (change === "destination") destination = "dm:+15555550003";
      if (change === "readiness") ready = false;
      if (change === "expired") setSystemTime(Date.now() + RETRY_WINDOW + 1);
      preview.resolve("https://media.example/preview.png");
      await ticking;
      expect(sends).toBe(0);
      expect(store.getOperation("card")?.state).toBe(change === "cancelled" || change === "rotated" ? "cancelled" : change === "expired" ? "failed" : "pending");
    } finally {setSystemTime(); store.close();}
  });
}

test("preview upload failure stays pending and known unsent, then retries the same card", async () => {
  const store = new Store(":memory:");
  let attempts = 0;
  let sends = 0;
  const line = new Sendblue({keyId:"test",secret:"test",number:"+15555550001",fetch:(async()=>{
    sends++;
    return json({message_handle:"accepted"});
  }) as unknown as typeof fetch});
  const transport = sbTransport(line,"dm:+15555550002",store,undefined,{static:true,previewImage:cardPreviewImage(async()=>{
    if (++attempts === 1) throw new Error("upload offline");
    return "https://media.example/preview.png";
  },(async(input: string | URL | Request)=> String(input) === url
    ? new Response('<meta property="og:image" content="preview.png">',{headers:{"content-type":"text/html"}})
    : new Response("bytes",{headers:{"content-type":"image/png"}})) as unknown as typeof fetch)});
  store.enqueue({id:"card",kind:"conversation",text:"",app:{url,caption:"Delivery tracking"}});
  const delivery = new Delivery(store,transport,{projectScope:"test",enabled:()=>true,chatGuid:()=>"dm:+15555550002"});
  try {
    await delivery.tick();
    expect(store.getOperation("card")?.state).toBe("pending");
    expect(store.get<boolean>("sendAmbiguous:card")).toBe(false);
    expect(delivery.status().lastError).toBe("card_preview_unavailable");
    expect(sends).toBe(0);
    setSystemTime(store.get<number>("retry:card")!);
    await delivery.tick();
    expect(sends).toBe(1);
    expect(store.getOperation("card")?.state).toBe("sent");
  } finally {setSystemTime();store.close();}
});

for (const change of ["cancelled", "rotated", "disabled", "destination", "readiness", "expired"] as const) {
  test(`retry history cannot send after dispatch guard changes: ${change}`, async () => {
    const store = new Store(":memory:");
    const entered = Promise.withResolvers<void>();
    const history = Promise.withResolvers<Response>();
    let enabled = true;
    let destination = "dm:+15555550002";
    let ready = true;
    let sends = 0;
    let previews = 0;
    const line = new Sendblue({keyId:"test",secret:"test",number:"+15555550001",fetch:(async(input: string | URL | Request)=>{
      if (new URL(String(input)).pathname === "/api/v2/messages") {entered.resolve(); return history.promise;}
      sends++;
      return json({message_handle:"must-not-send"});
    }) as unknown as typeof fetch});
    const transport = sbTransport(line,"dm:+15555550002",store,undefined,{static:true,previewImage:async()=>{previews++;return "https://media.example/p.png";}});
    const now = Date.now();
    store.set("route",{id:"session",generation:1});
    store.enqueue({id:"card",kind:"conversation",text:"",sessionId:"session",generation:1,app:{url,caption:"Delivery tracking"}});
    const {createHash} = await import("node:crypto");
    const chunkId = `bridge-${createHash("sha256").update("test:card:0").digest("hex")}`;
    store.set(`sent-attempt:${chunkId}`, {first:now-180_000,last:now-180_000});
    store.set("firstAttempt:card",now-180_000);
    store.set("sendAmbiguous:card",true);
    const delivery = new Delivery(store,transport,{projectScope:"test",enabled:()=>enabled,chatGuid:()=>destination,beforeSend:async()=>ready?"send":"wait"});
    try {
      const ticking=delivery.tick();
      await entered.promise;
      if(change==="cancelled")store.outboxState("card","cancelled");
      if(change==="rotated")store.set("route",{id:"session",generation:2});
      if(change==="disabled")enabled=false;
      if(change==="destination")destination="dm:+15555550003";
      if(change==="readiness")ready=false;
      if(change==="expired")setSystemTime(now+RETRY_WINDOW+1);
      history.resolve(json({data:[],has_more:false}));
      await ticking;
      expect(sends).toBe(0);
      expect(previews).toBe(1);
      expect(store.getOperation("card")?.state).toBe(change==="cancelled"||change==="rotated"?"cancelled":change==="expired"?"uncertain":"pending");
    } finally {setSystemTime();store.close();}
  });
}

test("lost app acknowledgement reconciles before preview lookup, including a legacy attempt without a prepared image", async () => {
  const store=new Store(":memory:");
  let sends=0;
  let previews=0;
  const at=Date.now();
  const line=new Sendblue({keyId:"test",secret:"test",number:"+15555550001",fetch:(async(input: string|URL|Request)=>{
    if(new URL(String(input)).pathname==="/api/v2/messages")return json({data:[{message_handle:"landed",is_outbound:true,number:"+15555550002",status:"DELIVERED",date_sent:new Date(at+1000).toISOString(),app_card:{url,layout:{caption:"Delivery tracking"}}}],has_more:false});
    sends++;throw new Error("must not send");
  }) as unknown as typeof fetch});
  const transport=sbTransport(line,"dm:+15555550002",store,()=>at+180_000,{static:true,previewImage:async()=>{previews++;throw new Error("page offline");}});
  store.set("sent-attempt:legacy",{first:at,last:at});
  try {
    expect(await transport.sendApp({id:"legacy",chatGuid:"x",url,caption:"Delivery tracking"})).toMatchObject({providerId:"landed",duplicate:true});
    expect(previews).toBe(0);
    expect(sends).toBe(0);
  } finally {store.close();}
});

test("a prepared image is reused after a definite provider rejection", async () => {
  const store=new Store(":memory:");
  let previews=0;
  let sends=0;
  const line=new Sendblue({keyId:"test",secret:"test",number:"+15555550001",fetch:(async()=>{
    return ++sends===1?new Response("",{status:400}):json({message_handle:"accepted"});
  }) as unknown as typeof fetch});
  const transport=sbTransport(line,"dm:+15555550002",store,undefined,{static:true,previewImage:async()=>{
    if(++previews>1)throw new Error("page offline");return "https://media.example/p.png";
  }});
  const input={id:"same-card",chatGuid:"x",url,caption:"Delivery tracking"};
  try {
    await expect(transport.sendApp(input)).rejects.toBeDefined();
    expect(await transport.sendApp(input)).toMatchObject({providerId:"accepted"});
    expect(previews).toBe(1);
    expect(sends).toBe(2);
  } finally {store.close();}
});

test("preparation failures count toward backoff and the attempt limit", async () => {
  const store=new Store(":memory:");
  const {LineError}=await import("../src/line.ts");
  const {MAX_ATTEMPTS}=await import("../src/delivery.ts");
  const photon={sendText:async()=>({}),sendApp:async()=>{throw new Error("must not send");},prepareApp:async()=>{throw new LineError("offline","card_preview_unavailable",true,false);}};
  const delivery=new Delivery(store,photon,{projectScope:"test",enabled:()=>true,chatGuid:()=>"x"});
  store.enqueue({id:"card",kind:"conversation",text:"",app:{url,caption:"Delivery tracking"}});
  try {
    const at=Date.now();
    await delivery.tick();
    expect(store.getOperation("card")).toMatchObject({state:"pending",attempts:1});
    const first=store.get<number>("retry:card")!;
    expect(first-at).toBeGreaterThanOrEqual(10_000);
    setSystemTime(first);
    await delivery.tick();
    expect(store.getOperation("card")).toMatchObject({state:"pending",attempts:2});
    expect(store.get<number>("retry:card")!-first).toBe(20_000);
    store.db.query("UPDATE outbox SET attempts = ? WHERE id = 'card'").run(MAX_ATTEMPTS-1);
    setSystemTime(store.get<number>("retry:card")!);
    await delivery.tick();
    expect(store.getOperation("card")).toMatchObject({state:"failed",attempts:MAX_ATTEMPTS});
    expect(store.get<boolean>("sendAmbiguous:card")).toBe(false);
  } finally {setSystemTime();store.close();}
});

for (const outcome of ["resolved", "rejected"] as const) {
  test(`a fresh card expires during ${outcome} preparation without resetting its first-attempt timestamp`, async () => {
  const store=new Store(":memory:");
  const entered=Promise.withResolvers<void>();
  const preview=Promise.withResolvers<string>();
  const start=Date.parse("2026-11-13T00:00:00Z");
  setSystemTime(start);
  let sends=0;
  const line=new Sendblue({keyId:"test",secret:"test",number:"+15555550001",fetch:(async()=>{sends++;return json({message_handle:"must-not-send"});}) as unknown as typeof fetch});
  const transport=sbTransport(line,"dm:+15555550002",store,undefined,{static:true,previewImage:async()=>{entered.resolve();return preview.promise;}});
  const delivery=new Delivery(store,transport,{projectScope:"test",enabled:()=>true,chatGuid:()=>"dm:+15555550002"});
  store.enqueue({id:"fresh",kind:"conversation",text:"",app:{url,caption:"Delivery tracking"}});
  try {
    const ticking=delivery.tick();
    await entered.promise;
    expect(store.get<number>("firstAttempt:fresh")).toBe(start);
    setSystemTime(start+RETRY_WINDOW+1);
    if (outcome === "resolved") preview.resolve("https://media.example/p.png");
    else {
      const {LineError}=await import("../src/line.ts");
      preview.reject(new LineError("offline","card_preview_unavailable",true,false));
    }
    await ticking;
    expect(sends).toBe(0);
    expect(store.getOperation("fresh")?.state).toBe("failed");
    expect(store.get<number>("firstAttempt:fresh")).toBe(start);
  } finally {setSystemTime();store.close();}
});

}
