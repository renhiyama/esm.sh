import type {
  Context,
  HttpMetadata,
  Middleware,
  PackageInfo,
  PackageRegistryInfo,
  WorkerStorage,
} from "../types/index.d.ts";
import { compareVersions, satisfies, validate } from "compare-versions";
import { getEsmaVersionFromUA, hasTargetSegment, targets } from "./compat.ts";
import {
  assetsExts,
  cssPackages,
  STABLE_VERSION,
  stableBuild,
  VERSION,
} from "./consts.ts";
import { getContentType } from "./content_type.ts";
import {
  asKV,
  checkPreflight,
  copyHeaders,
  corsHeaders,
  err,
  errPkgNotFound,
  fixPkgVersion,
  redirect,
  splitBy,
  trimPrefix,
} from "./utils.ts";

const regexpNpmNaming = /^[a-zA-Z0-9][\w\.\-\_]*$/;
const regexpFullVersion = /^\d+\.\d+\.\d+/;
const regexpCommitish = /^[a-f0-9]{10,}$/;
const regexpBuildVersion = /^(v\d+|stable)$/;
const regexpBuildVersionPrefix = /^\/(v\d+|stable)\//;

const defaultNpmRegistry = "https://registry.npmjs.org";
const defaultEsmServerOrigin = "https://esm.sh";

const fakeStorage: WorkerStorage = {
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(),
};

class ESMWorker {
  cache?: Cache;
  middleware?: Middleware;

  constructor(middleware?: Middleware) {
    this.middleware = middleware;
  }

  async fetch(
    req: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const resp = checkPreflight(req);
    if (resp) {
      return resp;
    }

    const url = new URL(req.url);
    const cache = this.cache ??
      (this.cache = await caches.open(`esm.sh/v${VERSION}`));
    const withCache: Context["withCache"] = async (fetcher, options) => {
      const isHeadMethod = req.method === "HEAD";
      const hasPinedTarget = targets.has(url.searchParams.get("target") ?? "");
      const varyUA = options?.varyUA && !hasPinedTarget;
      if (varyUA) {
        const target = getEsmaVersionFromUA(req.headers.get("User-Agent"));
        url.searchParams.set("target", target);
      }
      let res = await cache.match(url);
      if (res) {
        if (isHeadMethod) {
          const { status, headers } = res;
          return new Response(null, { status, headers });
        }
        return res;
      }
      res = await fetcher();
      if (varyUA) {
        const headers = new Headers(res.headers);
        headers.append("Vary", "User-Agent");
        res = new Response(res.body, { status: res.status, headers });
      }
      if (res.headers.get("Cache-Control")?.startsWith("public, max-age=")) {
        context.waitUntil(cache.put(url, res.clone()));
      }
      if (isHeadMethod) {
        const { status, headers } = res;
        return new Response(null, { status, headers });
      }
      return res;
    };
    const ctx: Context = {
      cache,
      url,
      data: {},
      waitUntil: (p: Promise<any>) => context.waitUntil(p),
      withCache,
    };
    // for deno runtime
    if (Reflect.has(context, "connInfo")) {
      Object.assign(ctx, Reflect.get(context, "connInfo"));
    }

    let pathname = decodeURIComponent(url.pathname);
    let buildVersion = "v" + VERSION;

    switch (pathname) {
      case "/build":
        if (req.method === "POST" || req.method === "PUT") {
          return fetchServerOrigin(
            req,
            env,
            ctx,
            `${pathname}${url.search}`,
            corsHeaders(),
          );
        }
        // fallthrough
      case "/error.js":
      case "/status.json":
        return fetchServerOrigin(
          req,
          env,
          ctx,
          `${pathname}${url.search}`,
          corsHeaders(),
        );
      case "/esma-target":
        return new Response(
          getEsmaVersionFromUA(req.headers.get("User-Agent")),
          { headers: corsHeaders() },
        );
      default:
        // ban malicious requests
        if (pathname.startsWith("/.") || pathname.endsWith(".php")) {
          return new Response("Not found", { status: 404 });
        }
    }

    // return deno CLI script
    if (
      req.headers.get("User-Agent")?.startsWith("Deno/") &&
      (pathname === "/" || /^\/v\d+\/?$/.test(pathname))
    ) {
      return fetchServerOrigin(
        req,
        env,
        ctx,
        `${pathname}${url.search}`,
        corsHeaders(),
      );
    }

    if (this.middleware) {
      const resp = await this.middleware(req, env, ctx);
      if (resp) {
        return resp;
      }
    }

    if (pathname === "/" || pathname.startsWith("/embed/")) {
      return fetchServerOrigin(
        req,
        env,
        ctx,
        `${pathname}${url.search}`,
        corsHeaders(),
      );
    }

    // fix `/jsx-runtime` path in query
    if (
      url.search.endsWith("/jsx-runtime") ||
      url.search.endsWith("/jsx-dev-runtime")
    ) {
      const [q, jsx] = splitBy(url.search, "/", true);
      pathname = pathname + "/" + jsx;
      url.search = q;
      url.pathname = pathname;
    }

    // strip build version prefix
    const hasBuildVerPrefix = regexpBuildVersionPrefix.test(pathname);
    const hasBuildVerQuery = !hasBuildVerPrefix &&
      regexpBuildVersion.test(url.searchParams.get("pin") ?? "");
    if (hasBuildVerPrefix) {
      const a = pathname.split("/");
      buildVersion = a[1];
      pathname = "/" + a.slice(2).join("/");
    } else if (hasBuildVerQuery) {
      buildVersion = url.searchParams.get("pin")!;
    }

    if (pathname === "/build" || pathname === "/server") {
      if (!hasBuildVerPrefix && !hasBuildVerQuery) {
        return redirect(
          new URL(`/${buildVersion}${pathname}`, url),
          302,
          86400,
        );
      }
      return ctx.withCache(() =>
        fetchServerOrigin(
          req,
          env,
          ctx,
          url.pathname + url.search,
          corsHeaders(),
        ), {
        varyUA: true,
      });
    }

    const gh = pathname.startsWith("/gh/");
    if (gh) {
      pathname = "/@" + pathname.slice(4);
    }

    // strip external all marker
    const hasExternalAllMarker = pathname.startsWith("/*");
    if (hasExternalAllMarker) {
      pathname = "/" + pathname.slice(2);
    }

    // strip loc
    if (/:\d+:\d+$/.test(pathname)) {
      pathname = splitBy(pathname, ":")[0];
    }

    if (
      hasBuildVerPrefix && (
        pathname === "/node.ns.d.ts" || (
          pathname.startsWith("/node_") &&
          pathname.endsWith(".js") &&
          pathname.slice(1).indexOf("/") === -1
        )
      )
    ) {
      // for old(deleted) ployfill
      if (pathname === "/node_buffer.js") {
        return redirect(
          new URL(`/${buildVersion}/buffer@6.0.3`, url),
          301,
        );
      }
      return ctx.withCache(() =>
        fetchESM(req, env, ctx, `/${buildVersion}${pathname}`, {
          gzip: true,
        })
      );
    }

    let packageScope = "";
    let packageName = "";
    let packageVersion = "";
    let subPath = "";
    let extraQuery = "";

    if (pathname.startsWith("/@")) {
      const [scope, name, ...rest] = decodeURIComponent(pathname).slice(2)
        .split("/");
      packageScope = "@" + scope;
      [packageName, packageVersion] = splitBy(name, "@");
      if (rest.length > 0) {
        subPath = "/" + rest.join("/");
      }
    } else {
      const [name, ...rest] = decodeURIComponent(pathname).slice(1).split("/");
      [packageName, packageVersion] = splitBy(name, "@");
      if (rest.length > 0) {
        subPath = "/" + rest.join("/");
      }
    }

    if (packageScope !== "" && !regexpNpmNaming.test(packageScope.slice(1))) {
      return err(`Invalid scope name '${packageScope}'`, 400);
    }

    if (packageName === "") {
      return err("Invalid path", 400);
    }

    const fromEsmsh = packageName.startsWith("~") &&
      regexpCommitish.test(packageName.slice(1));
    if (!fromEsmsh && !regexpNpmNaming.test(packageName)) {
      return err(`Invalid package name '${packageName}'`, 400);
    }

    let pkg = packageName;
    if (packageScope) {
      pkg = packageScope + "/" + packageName;
      if (gh) {
        // strip the leading `@`
        pkg = pkg.slice(1);
      }
    }

    // format package version
    if (packageVersion) {
      [packageVersion, extraQuery] = splitBy(packageVersion, "&");
      if (!gh) {
        if (packageVersion.startsWith("=") || packageVersion.startsWith("v")) {
          packageVersion = packageVersion.slice(1);
        } else if (/^\d+$/.test(packageVersion)) {
          packageVersion = "^" + packageVersion;
        } else if (/^\d+.\d+$/.test(packageVersion)) {
          packageVersion = "~" + packageVersion;
        }
      }
    }

    if (fromEsmsh) {
      packageVersion = "0.0.0";
    }

    // redirect to commit-ish version
    if (
      gh && !(
        packageVersion && (
          regexpCommitish.test(packageVersion) ||
          regexpFullVersion.test(trimPrefix(packageVersion, "v"))
        )
      )
    ) {
      return ctx.withCache(() =>
        fetchServerOrigin(
          req,
          env,
          ctx,
          url.pathname + url.search,
          corsHeaders(),
        )
      );
    }

    // redirect to specific version
    if (!gh && !(packageVersion && regexpFullVersion.test(packageVersion))) {
      return ctx.withCache(async () => {
        const headers = new Headers();
        if (env.NPM_TOKEN) {
          headers.set("Authorization", `Bearer ${env.NPM_TOKEN}`);
        }
        const res = await fetch(
          new URL(pkg, env.NPM_REGISTRY ?? defaultNpmRegistry),
          { headers },
        );
        if (!res.ok) {
          if (res.status === 404 || res.status === 401) {
            return errPkgNotFound(pkg);
          }
          return new Response(res.body, {
            status: res.status,
            headers: corsHeaders(),
          });
        }
        const regInfo: PackageRegistryInfo = await res.json();
        let prefix = "/";
        if (hasBuildVerPrefix) {
          prefix += buildVersion + "/";
        }
        if (hasExternalAllMarker) {
          prefix += "*";
        }
        const eq = extraQuery ? "&" + extraQuery : "";
        const distVersion = packageVersion
          ? regInfo["dist-tags"]?.[packageVersion]
          : undefined;
        if (distVersion) {
          const uri = `${prefix}${pkg}@${
            fixPkgVersion(pkg, distVersion)
          }${eq}${subPath}${url.search}`;
          return redirect(new URL(uri, url), 302);
        }
        const versions = Object.keys(regInfo.versions ?? []).filter(validate)
          .sort(compareVersions);
        if (!packageVersion) {
          const latestVersion = versions.filter((v) =>
            !v.includes("-")
          ).pop() ?? versions.pop();
          if (latestVersion) {
            const uri = `${prefix}${pkg}@${
              fixPkgVersion(pkg, latestVersion)
            }${eq}${subPath}${url.search}`;
            return redirect(new URL(uri, url), 302);
          }
        }
        try {
          const arr = packageVersion.includes("-")
            ? versions
            : versions.filter((v) => !v.includes("-"));
          for (let i = arr.length - 1; i >= 0; i--) {
            const v = arr[i];
            if (satisfies(v, packageVersion)) {
              const uri = `${prefix}${pkg}@${
                fixPkgVersion(pkg, v)
              }${eq}${subPath}${url.search}`;
              return redirect(new URL(uri, url), 302);
            }
          }
        } catch (_) {
          // error of `satisfies` function
          return err(`Invalid package version '${packageVersion}'`);
        }
        return err("Could not get the package version");
      });
    }

    // redirect `/@types/PKG` to `.d.ts` files
    if (
      pkg.startsWith("@types/") &&
      (subPath === "" || !subPath.endsWith(".d.ts"))
    ) {
      return ctx.withCache(async () => {
        let p = `/${buildVersion}${pathname}`;
        if (subPath !== "") {
          p += "~.d.ts";
        } else {
          const headers = new Headers();
          if (env.NPM_TOKEN) {
            headers.set("Authorization", `Bearer ${env.NPM_TOKEN}`);
          }
          const res = await fetch(
            new URL(pkg, env.NPM_REGISTRY ?? defaultNpmRegistry),
            { headers },
          );
          if (!res.ok) {
            if (res.status === 404 || res.status === 401) {
              return errPkgNotFound(pkg);
            }
            return new Response(res.body, { status: res.status, headers });
          }
          const pkgJson: PackageInfo = await res.json();
          p += "/" +
            (pkgJson.types || pkgJson.typings || pkgJson.main || "index.d.ts");
        }
        return redirect(new URL(p, url), 301);
      });
    }

    // redirect to main css for CSS packages
    let css: string | undefined;
    if (!gh && (css = cssPackages[pkg]) && subPath === "") {
      return redirect(
        new URL(`/${pkg}@${packageVersion}/${css}`, url),
        301,
      );
    }

    // redirect to real package css file: `/PKG?css` -> `/v100/PKG/es2022/pkg.css`
    if (url.searchParams.has("css") && subPath === "") {
      let prefix = `/${buildVersion}`;
      if (gh) {
        prefix += "/gh";
      }
      let target = url.searchParams.get("target");
      if (!target || !targets.has(target)) {
        const ua = req.headers.get("user-agent");
        target = getEsmaVersionFromUA(ua);
      }
      const pined = hasBuildVerPrefix || hasBuildVerQuery;
      return redirect(
        new URL(
          `${prefix}/${pkg}@${packageVersion}/${target}/${packageName}.css`,
          url,
        ),
        pined ? 301 : 302,
        86400,
      );
    }

    // redirect to real wasm file: `/v100/PKG/es2022/foo.wasm` -> `PKG/foo.wasm`
    if (hasBuildVerPrefix && subPath.endsWith(".wasm")) {
      return ctx.withCache(() => {
        return fetchServerOrigin(req, env, ctx, url.pathname, corsHeaders());
      });
    }

    // npm assets
    if (!hasBuildVerPrefix && subPath !== "") {
      const ext = splitBy(subPath, ".", true)[1];
      // append missed build version prefix for dts
      // example: `/@types/react/index.d.ts` -> `/v100/@types/react/index.d.ts`
      if (subPath.endsWith(".d.ts") || subPath.endsWith(".d.mts")) {
        return redirect(
          new URL("/v" + VERSION + url.pathname, url),
          301,
        );
      }
      // use origin server response for `*.wasm?module`
      if (ext === "wasm" && url.searchParams.has("module")) {
        return ctx.withCache(() => {
          return fetchServerOrigin(
            req,
            env,
            ctx,
            url.pathname + "?module",
            corsHeaders(),
          );
        });
      }
      if (assetsExts.has(ext)) {
        return ctx.withCache(() => {
          const pathname = `${
            gh ? "/gh" : ""
          }/${pkg}@${packageVersion}${subPath}`;
          return fetchAsset(req, ctx, env, pathname);
        });
      }
    }

    // apply extraQuery
    if (extraQuery) {
      const params = new URLSearchParams(extraQuery);
      params.forEach((val, key) => {
        url.searchParams.set(key, val);
      });
    }

    if (
      hasBuildVerPrefix &&
      (subPath.endsWith(".d.ts") || hasTargetSegment(subPath))
    ) {
      // fix "stable" module path
      // if (
      //   stableBuild.has(pkg) &&
      //   !subPath.endsWith(".d.ts") &&
      //   (subPath.endsWith(`/${pkg}.js`) ||
      //     !url.pathname.startsWith("/stable/")) &&
      //   subPath.split("/").length === 3
      // ) {
      //   const [_, target] = subPath.split("/");
      //   return redirect(
      //     new URL(`/${pkg}@${packageVersion}?target=${target}`, url),
      //     301,
      //   );
      // }
      return ctx.withCache(() => {
        let prefix = `/${buildVersion}`;
        if (gh) {
          prefix += "/gh";
        }
        const path =
          `${prefix}/${pkg}@${packageVersion}${subPath}${url.search}`;
        return fetchESM(req, env, ctx, path, { gzip: true });
      });
    }

    return ctx.withCache(() => {
      let prefix = "";
      if (hasBuildVerPrefix) {
        prefix += `/${buildVersion}`;
      } else if (stableBuild.has(pkg)) {
        prefix += `/v${STABLE_VERSION}`;
      }
      if (gh) {
        prefix += "/gh";
      }
      const path = `${prefix}/${
        hasExternalAllMarker ? "*" : ""
      }${pkg}@${packageVersion}${subPath}${url.search}`;
      return fetchESM(req, env, ctx, path, { gzip: false });
    }, { varyUA: true });
  }
}

async function fetchAsset(
  req: Request,
  ctx: Context,
  env: Env,
  pathname: string,
) {
  const resHeaders = corsHeaders();
  const storage = Reflect.get(env, "R2") as R2Bucket | undefined ?? fakeStorage;
  const ret = await storage.get(pathname.slice(1));
  if (ret) {
    resHeaders.set(
      "Content-Type",
      ret.httpMetadata?.contentType || getContentType(pathname),
    );
    resHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
    resHeaders.set("X-Content-Source", "esm-worker");
    return new Response(ret.body as ReadableStream<Uint8Array>, {
      headers: resHeaders,
    });
  }

  const res = await fetchServerOrigin(req, env, ctx, pathname, resHeaders);
  if (res.ok) {
    const contentType = res.headers.get("content-type") ||
      getContentType(pathname);
    const buffer = await res.arrayBuffer();
    await storage.put(pathname.slice(1), buffer.slice(0), {
      httpMetadata: { contentType },
    });
    resHeaders.set("Content-Type", contentType);
    resHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
    resHeaders.set(
      "X-Content-Source",
      env.ESM_ORIGIN ?? defaultEsmServerOrigin,
    );
    return new Response(buffer.slice(0), { headers: resHeaders });
  }
  return res;
}

async function fetchESM(
  req: Request,
  env: Env,
  ctx: Context,
  path: string,
  options: { gzip: boolean },
): Promise<Response> {
  let storeKey = path.slice(1);
  if (storeKey.startsWith("stable/")) {
    storeKey = `v${STABLE_VERSION}/` + storeKey.slice(7);
  }
  const headers = corsHeaders();
  const [pathname] = splitBy(path, "?", true);
  const storage = Reflect.get(env, "R2") as R2Bucket | undefined ?? fakeStorage;
  const KV = Reflect.get(env, "KV") as KVNamespace | undefined ?? asKV(storage);
  const noStore = req.headers.has("X-Real-Origin");
  const isModuleFile = !(
    pathname.endsWith(".d.ts") ||
    pathname.endsWith(".d.mts") ||
    pathname.endsWith(".map")
  );
  if (!noStore) {
    if (isModuleFile) {
      const { value, metadata } = await KV.getWithMetadata<HttpMetadata>(
        storeKey,
        "stream",
      );
      if (value && metadata) {
        let body = value as ReadableStream<Uint8Array>;
        if (options.gzip) {
          body = body.pipeThrough(new DecompressionStream("gzip"));
        }
        headers.set("Content-Type", metadata.contentType);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        if (metadata.dts) {
          headers.set("X-TypeScript-Types", metadata.dts);
          headers.set("Access-Control-Expose-Headers", "X-TypeScript-Types");
        }
        headers.set("X-Content-Source", "esm-worker");
        return new Response(body, { headers });
      }
    } else {
      const obj = await storage.get(storeKey);
      if (obj) {
        const contentType = obj.httpMetadata?.contentType ||
          getContentType(path);
        headers.set("Content-Type", contentType);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        headers.set("X-Content-Source", "esm-worker");
        return new Response(obj.body, { headers });
      }
    }
  }

  const res = await fetchServerOrigin(req, env, ctx, path, headers);
  if (!res.ok) {
    return res;
  }

  const contentType = res.headers.get("Content-Type") || getContentType(path);
  const cacheControl = res.headers.get("Cache-Control");
  const dts = res.headers.get("X-TypeScript-Types");

  headers.set("Content-Type", contentType);
  if (cacheControl) {
    headers.set("Cache-Control", cacheControl);
  }
  if (dts) {
    headers.set("X-TypeScript-Types", dts);
    headers.set("Access-Control-Expose-Headers", "X-TypeScript-Types");
  }
  headers.set(
    "X-Content-Source",
    env.ESM_ORIGIN ?? defaultEsmServerOrigin,
  );

  // save to KV/R2 if immutable
  if (!noStore && cacheControl?.includes("immutable")) {
    if (!isModuleFile) {
      const buffer = await res.arrayBuffer();
      await storage.put(storeKey, buffer.slice(0), {
        httpMetadata: { contentType },
      });
      return new Response(buffer.slice(0), { headers });
    }
    let body: ReadableStream<Uint8Array> | ArrayBuffer;
    let value: ReadableStream<Uint8Array> | ArrayBuffer;
    try {
      const [a, b] = res.body!.tee();
      body = a;
      value = options.gzip ? b.pipeThrough(new CompressionStream("gzip")) : b;
    } catch (_) {
      // failed to tee, fallback to arrayBuffer
      const buffer = await res.arrayBuffer();
      body = buffer.slice(0);
      value = options.gzip
        ? new Response(buffer.slice(0)).body!.pipeThrough(
          new CompressionStream("gzip"),
        )
        : buffer.slice(0);
    }
    await KV.put(storeKey, value as any, { metadata: { contentType, dts } });
    return new Response(body, { headers });
  }

  return new Response(res.body, { headers });
}

async function fetchServerOrigin(
  req: Request,
  env: Env,
  ctx: Context,
  url: string,
  resHeaders: Headers,
): Promise<Response> {
  const headers = new Headers();
  copyHeaders(
    headers,
    req.headers,
    "Accept-Encoding",
    "Content-Type",
    "Origin",
    "Referer",
    "User-Agent",
    "X-Esm-Worker-Version",
    "X-Forwarded-For",
    "X-Real-Ip",
    "X-Real-Origin",
  );
  if (!headers.has("X-Esm-Worker-Version")) {
    headers.set("X-Esm-Worker-Version", `v${VERSION}`);
  }
  if (!headers.has("X-Real-Origin")) {
    headers.set("X-Real-Origin", ctx.url.origin);
  }
  if (env.ESM_TOKEN) {
    headers.set("Authorization", `Bearer ${env.ESM_TOKEN}`);
  }
  const res = await fetch(
    new URL(url, env.ESM_ORIGIN ?? defaultEsmServerOrigin),
    {
      method: req.method === "HEAD" ? "GET" : req.method,
      body: req.body,
      headers,
      redirect: "manual",
    },
  );
  if (!res.ok) {
    // fix cache-control by status code
    if (res.headers.has("Cache-Control")) {
      resHeaders.set("Cache-Control", res.headers.get("Cache-Control")!);
    } else if (res.status === 301 || res.status === 400) {
      resHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
    } else if (res.status === 302) {
      resHeaders.set("Cache-Control", "public, max-age=600");
    } else if (res.status === 404) {
      const message = await res.text();
      if (!/package .+ not found/.test(message)) {
        resHeaders.set(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
      }
      return new Response(message, { status: 404, headers: resHeaders });
    } else if (res.status === 500) {
      resHeaders.set("Cache-Control", "public, max-age=60");
    }
    if (res.status === 301 || res.status === 302) {
      // await res.body?.cancel?.()
      return redirect(res.headers.get("Location")!, res.status);
    }
    if (
      res.status === 500 &&
      res.headers.get("Content-Type")?.startsWith("text/html")
    ) {
      // await res.body?.cancel?.();
      return new Response("Bad Gateway", { status: 502, headers: resHeaders });
    }
    return new Response(res.body, { status: res.status, headers: resHeaders });
  }
  copyHeaders(
    resHeaders,
    res.headers,
    "Cache-Control",
    "Content-Type",
    "Content-Length",
    "X-Typescript-Types",
  );
  if (resHeaders.has("X-Typescript-Types")) {
    resHeaders.set("Access-Control-Expose-Headers", "X-TypeScript-Types");
  }
  return new Response(res.body, { headers: resHeaders });
}

export function withESMWorker(middleware?: Middleware): ESMWorker {
  return new ESMWorker(middleware);
}

export default withESMWorker;

export const version = `v${VERSION}`;
