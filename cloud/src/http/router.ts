import type { Handler, HttpMethod, RouteMeta } from "./context";

export interface RouteInfo {
  readonly method: HttpMethod;
  /** OpenAPI-style pattern, for example `/v1/devices/{device_id}`. */
  readonly pattern: string;
  readonly meta: RouteMeta;
}

interface Registered extends RouteInfo {
  readonly handler: Handler;
  readonly segments: readonly string[];
  readonly paramCount: number;
}

export interface RouteMatch {
  readonly route: RouteInfo;
  readonly handler: Handler;
  readonly params: Record<string, string>;
}

const PARAM = /^\{([a-z_][a-z0-9_]*)\}$/;

/**
 * A tiny router. Modules register their routes with `router.add(method, pattern, handler, meta)`.
 * Patterns use the OpenAPI spelling (`{name}` matches one whole path segment). Registering the same
 * method and pattern twice throws, so replacing a stub means editing the module that registered it.
 */
export class Router {
  private readonly table: Registered[] = [];

  add(method: HttpMethod, pattern: string, handler: Handler, meta: RouteMeta): void {
    if (!pattern.startsWith("/") || (pattern.length > 1 && pattern.endsWith("/"))) {
      throw new Error(`invalid route pattern ${pattern}`);
    }
    const segments = pattern.split("/").slice(1);
    for (const s of segments) {
      if (s.includes("{") && !PARAM.test(s)) throw new Error(`a parameter must fill a whole segment: ${pattern}`);
    }
    if (this.table.some((r) => r.method === method && r.pattern === pattern)) {
      throw new Error(`route registered twice: ${method} ${pattern}`);
    }
    this.table.push({ method, pattern, meta, handler, segments, paramCount: segments.filter((s) => PARAM.test(s)).length });
  }

  routes(): readonly RouteInfo[] {
    return this.table.map(({ method, pattern, meta }) => ({ method, pattern, meta }));
  }

  /** Static segments win over parameters. Returns undefined when nothing matches. */
  match(method: string, pathname: string): RouteMatch | undefined {
    const parts = pathname.split("/").slice(1);
    let best: { route: Registered; params: Record<string, string> } | undefined;
    for (const route of this.table) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length && ok; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        const param = PARAM.exec(seg);
        if (param) {
          let value: string;
          try {
            value = decodeURIComponent(part);
          } catch {
            ok = false;
            break;
          }
          if (value === "") ok = false;
          else params[param[1]!] = value;
        } else if (seg !== part) {
          ok = false;
        }
      }
      if (ok && (!best || route.paramCount < best.route.paramCount)) best = { route, params };
    }
    if (!best) return undefined;
    const { method: m, pattern, meta, handler } = best.route;
    return { route: { method: m, pattern, meta }, handler, params: best.params };
  }
}
