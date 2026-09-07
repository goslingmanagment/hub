import { kernel } from "./sdk.js";
export const readOfapiKeyScope = () => kernel.ofapiKeyScopeGet();
export const applyOfapiKeyScope = (body: Parameters<typeof kernel.ofapiKeyScopeApply>[0]["body"]) => kernel.ofapiKeyScopeApply({ body });
export const readOfapiVendorUsage = (body: Parameters<typeof kernel.ofapiVendorUsageRefresh>[0]["body"]) => kernel.ofapiVendorUsageRefresh({ body });
