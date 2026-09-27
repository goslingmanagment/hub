// Synthetic OFAPI media fixtures for the desktop media-images tests. Every id,
// path, address and signature here is invented: no real signed URL, fan id
// or content. Shapes follow the vendored OFAPI spec
// (reference/onlyfansapi/openapi.yaml, media[].files.{full,thumb,preview,squarePreview}.url)
// and the observed split: webhooks carry canned-policy (Expires) URLs, gateway
// reads carry custom-policy (Policy + IpAddress) URLs bound to the OFAPI proxy.

export const MEDIA_ACCOUNT = "acct_05000000000000000000000000000000";
export const MEDIA_FAN_ID = 1000005;
export const MEDIA_MESSAGE_ID = 2000001;

/** CloudFront's URL-safe base64 (`+`→`-`, `=`→`_`, `/`→`~`). */
export function syntheticCloudFrontPolicy(epochSeconds: number, sourceIp: string | null = "192.0.2.10/32") {
  const policy = {
    Statement: [{
      Resource: "https://cdn2.onlyfans.com/files/*",
      Condition: {
        DateLessThan: { "AWS:EpochTime": epochSeconds },
        ...(sourceIp ? { IpAddress: { "AWS:SourceIp": sourceIp } } : {}),
      },
    }],
  };
  return Buffer.from(JSON.stringify(policy)).toString("base64")
    .replaceAll("+", "-").replaceAll("=", "_").replaceAll("/", "~");
}

export function expiresSignedUrl(path: string, expiresAt: Date) {
  return `https://cdn2.onlyfans.com/files/${path}?Tag=2&u=${MEDIA_FAN_ID}`
    + `&Expires=${Math.floor(expiresAt.getTime() / 1000)}&Signature=SYNTHETIC~SIGNATURE__&Key-Pair-Id=SYNTHETICKEYPAIR`;
}

export function policySignedUrl(path: string, expiresAt: Date) {
  return `https://cdn2.onlyfans.com/files/${path}?Tag=2&u=9000001`
    + `&Policy=${syntheticCloudFrontPolicy(Math.floor(expiresAt.getTime() / 1000))}`
    + "&Signature=SYNTHETIC~SIGNATURE__&Key-Pair-Id=SYNTHETICKEYPAIR";
}

export function fansapiCacheUrl(path: string, signedAt: Date, ttlSeconds = 3600) {
  const stamp = signedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `https://cdn.fansapi.com/of/cdn2/files/${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256`
    + `&X-Amz-Credential=SYNTHETIC&X-Amz-Date=${stamp}&X-Amz-Expires=${ttlSeconds}`
    + "&X-Amz-SignedHeaders=host&X-Amz-Signature=synthetic";
}

type UrlMaker = (path: string, expiresAt: Date) => string;

export function photoMedia(id: number, sign: UrlMaker, expiresAt: Date, overrides: Record<string, unknown> = {}) {
  const base = `a/aa/syn${id}`;
  return {
    id, type: "photo", convertedToVideo: false, canView: true, hasError: false, isReady: true, createdAt: null,
    files: {
      full: { url: sign(`${base}/960x1280_syn${id}.jpg`, expiresAt), width: 960, height: 1280, size: 0 },
      thumb: { url: sign(`${base}/300x300_syn${id}.jpg`, expiresAt), width: 300, height: 300, size: 0 },
      preview: { url: sign(`${base}/480x640_syn${id}.jpg`, expiresAt), width: 480, height: 640, size: 0 },
      squarePreview: { url: sign(`${base}/960x960_syn${id}.jpg`, expiresAt), width: 960, height: 960, size: 0 },
    },
    ...overrides,
  };
}

export function videoMedia(id: number, sign: UrlMaker, expiresAt: Date) {
  const base = `b/bb/syn${id}`;
  return {
    id, type: "video", canView: true, hasError: false, isReady: true, duration: 9,
    files: {
      full: { url: null, width: 480, height: 848, size: 0 },
      thumb: { url: sign(`${base}/300x300_syn${id}.jpg`, expiresAt), width: 300, height: 300, size: 0 },
      preview: { url: sign(`${base}/480x848_syn${id}.jpg`, expiresAt), width: 480, height: 848, size: 0 },
    },
  };
}

/** A locked PPV item: the vendor sends only a `full` key without a URL. */
export function lockedMedia(id: number) {
  return { id, type: "photo", canView: false, hasError: false, isReady: true, files: { full: { url: null } } };
}

/** `messages.received` envelope as the receiver journals it. */
export function syntheticMessagesReceived(input: { messageId?: number; media: unknown[]; account?: string }) {
  return {
    event: "messages.received",
    account_id: input.account ?? MEDIA_ACCOUNT,
    payload: {
      responseType: "message",
      text: "<p>Synthetic fan message.</p>",
      price: 0,
      isFree: true,
      mediaCount: input.media.length,
      media: input.media,
      previews: [],
      isTip: false,
      fromUser: { id: MEDIA_FAN_ID, name: "Synthetic Fan", username: "synthetic_fan" },
      id: input.messageId ?? MEDIA_MESSAGE_ID,
      isOpened: false,
      isNew: true,
      createdAt: "2026-09-27T03:49:02+00:00",
    },
  };
}

/** A `GET /{acct}/chats/{chatId}/media` gallery page. */
export function syntheticChatMediaPage(media: unknown[], messageId = 2000002) {
  return {
    data: {
      list: [{
        id: messageId, text: "", price: 0, isOpened: null, mediaCount: media.length, media,
        fromUser: { id: MEDIA_FAN_ID }, createdAt: "2026-09-27T03:49:02+00:00",
      }],
      hasMore: false,
      nextLastId: null,
    },
    _meta: { _credits: { used: 1, balance: 1000 } },
  };
}

/** A `GET /{acct}/media/vault` page. */
export function syntheticVaultPage(media: unknown[]) {
  return { data: { list: media, hasMore: false }, _meta: { _credits: { used: 1, balance: 1000 } } };
}
