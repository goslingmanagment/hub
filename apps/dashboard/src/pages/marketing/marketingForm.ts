import { KernelApiError, ofapiMarketingActionSchema, type OfapiMarketingAction, type OfapiMarketingResource, type OfapiMarketingMetric, type OfapiMarketingPreviewValue } from "@agency_hub_core/contracts";

export const actionLabels: Record<OfapiMarketingAction["action"], string> = {
  smart_link_create: "Создать Smart Link", smart_link_delete: "Удалить Smart Link",
  tags_add: "Добавить теги", tags_remove: "Снять теги", pixel_create: "Подключить пиксель",
  pixel_update: "Изменить общий пиксель", pixel_disconnect: "Отключить пиксель от ссылки",
  pixel_test: "Отправить тестовое событие", postback_create: "Создать postback",
  postback_update: "Изменить postback", postback_delete: "Удалить postback",
};
export const eventFields = ["event_click", "event_new_subscriber", "event_first_transaction", "event_new_transaction", "event_message_received_from_fan", "event_fan_sent_1_message", "event_fan_sent_3_messages"] as const;
export const eventLabels: Record<string, string> = {
  event_new_subscriber_free: "Новая бесплатная подписка", event_new_subscriber_paid: "Новая платная подписка",
  event_click: "Клик", event_new_subscriber: "Новая подписка", event_first_transaction: "Первая покупка",
  event_new_transaction: "Покупка", event_message_received_from_fan: "Сообщение фана",
  event_fan_sent_1_message: "Первое сообщение", event_fan_sent_3_messages: "Три сообщения",
  new_subscriber: "Новая подписка", new_transaction: "Покупка", message_received: "Сообщение фана",
  fan_sent_1_message: "Первое сообщение", fan_sent_3_messages: "Три сообщения",
};
export const conversionTypes = ["new_subscriber", "new_transaction", "message_received", "fan_sent_1_message", "fan_sent_3_messages"] as const;
export interface MarketingForm {
  action: OfapiMarketingAction["action"]; pageId: number; linkId: string; resourceId: string;
  name: string; linkType: "tracking_link" | "free_trial"; trialDays: string; tags: string;
  platform: "meta" | "snapchat" | "tiktok" | "creatortraffic"; platformPixelId: string; token: string;
  eventSourceUrl: string; events: Record<string, string>; testEvent: string; testCode: string;
  url: string; method: "GET" | "POST"; body: string; headers: Array<{ name: string; value: string }>;
  scope: "global" | "campaign_specific"; conversions: string[]; linkIds: string[];
  clearBody: boolean; clearHeaders: boolean; clearEventSourceUrl: boolean;
  pixelBaseline: { name: string; platformPixelId: string; events: Record<string,string> };
}
export function newMarketingForm(action: MarketingForm["action"], pageId: number, resource?: OfapiMarketingResource): MarketingForm {
  const events=Object.fromEntries(eventFields.map(key => [key, resource?.eventNames[key] ?? ""]));
  return {
    action, pageId, linkId: resource?.kind === "smart_link" ? resource.id : resource?.parentId ?? "", resourceId: resource?.id ?? "",
    name: resource?.name ?? "", linkType: "tracking_link", trialDays: "7", tags: resource?.tags.join("\n") ?? "",
    platform: (["meta", "snapchat", "tiktok", "creatortraffic"].includes(resource?.platform ?? "") ? resource!.platform : "meta") as MarketingForm["platform"],
    platformPixelId: resource?.platformPixelId ?? "", token: "", eventSourceUrl: "", events,
    testEvent: "event_click", testCode: "", url: "", method: resource?.httpMethod ?? "POST", body: "", headers: [],
    clearBody:false,clearHeaders:false,clearEventSourceUrl:false,pixelBaseline:{name:resource?.name ?? "",platformPixelId:resource?.platformPixelId ?? "",events:{...events}},
    scope: resource?.scope === "global" ? "global" : "campaign_specific", conversions: resource?.conversionTypes.length ? [...resource.conversionTypes] : ["new_subscriber"], linkIds: [...(resource?.linkIds ?? [])],
  };
}
/** Compile only the selected, closed action; hidden inputs cannot add another write. */
export function buildMarketingCommand(form: MarketingForm): OfapiMarketingAction {
  const action = form.action;
  const target = { action, pageId: form.pageId, linkId: form.linkId };
  let command: unknown;
  if (action === "smart_link_create") command = { action, pageId: form.pageId, name: form.name.trim(), link_type: form.linkType, ...(form.linkType === "free_trial" ? { free_trial_days: Number(form.trialDays) } : {}) };
  else if (action === "smart_link_delete") command = target;
  else if (action === "tags_add" || action === "tags_remove") command = { ...target, tags: [...new Set(form.tags.split("\n").map(value => value.trim()).filter(Boolean))] };
  else if (action === "pixel_disconnect") command = { ...target, pixelId: Number(form.resourceId) };
  else if (action === "pixel_test") command = { ...target, pixelId: Number(form.resourceId), event_type: form.testEvent, ...(form.testCode.trim() ? { test_event_code: form.testCode.trim() } : {}) };
  else if (action === "pixel_create") command = {
    ...target, platform:form.platform,pixel_id:form.platformPixelId.trim(),pixel_access_token:form.token,
    ...(form.name.trim() ? {label:form.name.trim()} : {}),
    ...(form.eventSourceUrl.trim() ? {event_source_url:form.eventSourceUrl.trim()} : {}),
    ...Object.fromEntries(eventFields.filter(key=>form.events[key]?.trim()).map(key=>[key,form.events[key]!.trim()])),
  };
  else if (action === "pixel_update") {
    const changed = {
      ...(form.name.trim() !== form.pixelBaseline.name.trim() ? {label:form.name.trim() || null} : {}),
      ...(form.platformPixelId.trim() !== form.pixelBaseline.platformPixelId.trim() ? {pixel_id:form.platformPixelId.trim()} : {}),
      ...(form.token ? {pixel_access_token:form.token} : {}),
      ...(form.clearEventSourceUrl ? {event_source_url:null} : form.eventSourceUrl.trim() ? {event_source_url:form.eventSourceUrl.trim()} : {}),
      ...Object.fromEntries(eventFields.filter(key=>(form.events[key]?.trim() ?? "") !== (form.pixelBaseline.events[key]?.trim() ?? "")).map(key=>[key,form.events[key]?.trim() || null])),
    };
    if (!Object.keys(changed).length) throw new Error("Измените хотя бы одно поле пикселя.");
    command={...target,pixelId:Number(form.resourceId),...changed};
  }
  else if (action === "postback_delete") command = { action, postbackId: Number(form.resourceId) };
  else command = {
    action, ...(action === "postback_update" ? { postbackId: Number(form.resourceId) } : {}),
    url: form.url.trim(), http_method: form.method, smart_link_scope: form.scope,
    conversion_types: form.conversions, ...(form.scope === "campaign_specific" ? { smart_link_ids: form.linkIds } : {}),
    ...(action === "postback_update" && form.clearBody ? {body:""} : form.body ? { body: form.body } : {}),
    ...(action === "postback_update" && form.clearHeaders ? {headers:[]} : form.headers.length ? { headers: form.headers } : {}),
  };
  return ofapiMarketingActionSchema.parse(command);
}

/** Keep the chosen amount and its own basis together, including an explicit zero. */
export function marketingDisplayMoney(row: OfapiMarketingMetric) {
  if(row.revenueMills != null) return {mills:row.revenueMills,basis:row.revenueBasis ?? "unspecified"};
  if(row.amountNetMills != null) return {mills:row.amountNetMills,basis:"net"};
  if(row.amountGrossMills != null) return {mills:row.amountGrossMills,basis:"gross"};
  return {mills:null,basis:null};
}
export function marketingFlag(label:string,value:boolean|null|undefined) {
  return `${label}: ${value === true ? "да" : value === false ? "нет" : "неизвестно"}`;
}
export function marketingPixelCanTest(platform:string|null) {return platform !== "creatortraffic";}

export function marketingMatches(term: string, ...values: unknown[]) {
  const needle = term.trim().toLocaleLowerCase();
  return !needle || values.some(value => value != null && String(value).toLocaleLowerCase().includes(needle));
}

/** Freeze once before prepare; a lost reply must reuse this ID and exact command. */
export function createMarketingPreparation(form: MarketingForm, id: string) {
  return { id, command: structuredClone(buildMarketingCommand(form)) };
}

export function marketingFailureUncertain(error: unknown, previouslyUncertain = false) {
  // A later refusal can concern changed access or policy before the server reads
  // the original intent. It cannot prove that the first request did not execute.
  return previouslyUncertain || !(error instanceof KernelApiError && error.category !== "contract" && error.status !== null && error.status >= 400 && error.status < 500);
}

export const marketingPreviewFieldLabels:Record<OfapiMarketingPreviewValue["field"],string>={
  name:"Название",link_type:"Предложение",free_trial_days:"Дней бесплатного доступа",tags:"Теги",label:"Название пикселя",platform:"Платформа",pixel_id:"ID рекламной платформы",
  event_click:"Событие: клик",event_new_subscriber:"Событие: новая подписка",event_first_transaction:"Событие: первая покупка",event_new_transaction:"Событие: покупка",event_message_received_from_fan:"Событие: сообщение фана",event_fan_sent_1_message:"Событие: первое сообщение",event_fan_sent_3_messages:"Событие: три сообщения",event_type:"Тестовое событие",http_method:"Метод",
  body_change:"Тело postback",headers_change:"Заголовки postback",pixel_token_change:"Токен пикселя",test_event_code_change:"Код тестового события",event_source_url_change:"URL источника событий",
};
export function marketingPreviewValue(item:OfapiMarketingPreviewValue) {
  if(item.field.endsWith("_change")) return item.value==="clear" ? "Удалить сохранённое значение" : item.value==="preserve" ? "Сохранить текущее значение" : item.value==="default" ? "Значение провайдера по умолчанию" : "Заменить значение";
  if(item.value===null) return "Очистить значение";
  if(Array.isArray(item.value)) return item.value.join(", ");
  if(item.field==="link_type") return item.value==="free_trial" ? "Бесплатный пробный период" : "Обычная отслеживаемая ссылка";
  if(item.field==="event_type") return eventLabels[String(item.value)] ?? String(item.value);
  return String(item.value);
}
