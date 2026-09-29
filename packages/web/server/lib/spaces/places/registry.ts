export const REQUIRED_PLACE_METHODS = ['check', 'create', 'list', 'exec', 'execArgv', 'connect', 'stop', 'start', 'remove', 'verify'] as const;

type PlaceMethod = (typeof REQUIRED_PLACE_METHODS)[number];

export interface RegistryPlace extends Record<PlaceMethod, (...args: never[]) => unknown> {
  id: unknown;
}

export function createPlaceRegistry<P extends RegistryPlace>(initialPlaces: P[] = []) {
  const places = new Map<string, P>();
  let sealed = false;

  const register = (place: P) => {
    if (sealed) {
      throw new Error('Place registry is sealed; no further registrations allowed');
    }
    const key = String(place?.id ?? '').trim().toLowerCase();
    if (key.length === 0) {
      throw new Error('Place must define a non-empty id');
    }
    for (const method of REQUIRED_PLACE_METHODS) {
      if (!(place[method] instanceof Function)) {
        throw new Error(`Place '${key}' must implement ${method}()`);
      }
    }
    if (places.has(key)) {
      throw new Error(`Place '${key}' is already registered`);
    }
    places.set(key, place);
    return place;
  };

  const get = (placeId: unknown) => places.get(String(placeId ?? '').trim().toLowerCase()) ?? null;

  const list = () => Array.from(places.values());

  for (const place of initialPlaces) {
    register(place);
  }

  const seal = () => { sealed = true; };

  return {
    register,
    get,
    list,
    seal,
  };
}
