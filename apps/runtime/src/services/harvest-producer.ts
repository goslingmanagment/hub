// The harvest uploader's producer stamp. Its own module, free of imports, so
// the client-capture canonicalizer and the ingest route (which reads the
// canonicalizer registry) can both use it without importing each other.

export const HARVEST_PRODUCER_PREFIX = "desktop-harvest@";

export function isHarvestProducer(producer: string) {
  return producer.startsWith(HARVEST_PRODUCER_PREFIX);
}
