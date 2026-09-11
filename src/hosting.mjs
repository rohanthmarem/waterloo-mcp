import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  realpath,
  readdir,
  chown,
} from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { readConfig, root } from "./config.mjs";
import { provisionOwner } from "./portable-auth.mjs";

export const userId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const userSchema = z
  .object({
    id: userId,
    origin: z.string(),
    owner: z.string().email(),
    username: z.string().regex(/^[a-z0-9._-]+@uwaterloo\.ca$/i),
    port: z.number().int().min(1024).max(65535),
    racket: z.boolean().default(false),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["single", "multi"]),
    uid: z.number().int().positive(),
    gid: z.number().int().nonnegative(),
    users: z.array(userSchema),
  })
  .strict();
export const hostingDir = (base = root) => path.join(base, "private/hosting");
export const userHome = (dir, id) => path.join(dir, "users", userId.parse(id));
function validateLocalPort(u) {
  const origin = new URL(u.origin);
  if (
    origin.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(origin.hostname) &&
    Number(origin.port || (origin.protocol === "https:" ? 443 : 80)) !== u.port
  )
    throw new Error("HOST_LOCAL_PORT_MISMATCH");
}
export async function loadHost(dir) {
  const m = manifestSchema.parse(
    JSON.parse(await readFile(path.join(dir, "host.json"), "utf8")),
  );
  if (m.mode === "single" && m.users.length > 1)
    throw new Error("HOST_SINGLE_USER_LIMIT");
  for (const u of m.users) {
    validateLocalPort(u);
    readConfig({
      WATERLOO_AUTH_MODE: "portable",
      WATERLOO_ORIGIN: u.origin,
      WATERLOO_OWNER_EMAIL: u.owner,
      D2L_USERNAME: u.username,
    });
  }
  for (const field of ["id", "port", "origin", "owner", "username"])
    if (
      new Set(m.users.map((u) => String(u[field]).toLowerCase())).size !==
      m.users.length
    )
      throw new Error("HOST_DUPLICATE_USER_CONFIG");
  // Cookies are scoped to hostnames, NOT ports. Never host two users at localhost:PORT.
  if (
    new Set(m.users.map((u) => new URL(u.origin).hostname)).size !==
    m.users.length
  )
    throw new Error("HOST_SHARED_COOKIE_HOST");
  return m;
}
async function save(file, data) {
  await writeFile(file + ".pending", JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(file + ".pending", file);
}
export async function initializeHost(dir, mode) {
  if (!["single", "multi"].includes(mode)) throw new Error("HOST_MODE_INVALID");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(dir, "host.json"),
    JSON.stringify(
      {
        version: 1,
        mode,
        uid: process.getuid?.() || 1001,
        gid: process.getuid?.() ? process.getgid() : 1001,
        users: [],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
export function composeFor(dir, manifest, sourceRoot = root) {
  const services = {},
    networks = {};
  for (const u of manifest.users) {
    const home = userHome(dir, u.id);
    networks[u.id] = {};
    services[u.id] = {
      build: { context: sourceRoot },
      image:
        "waterloo-host-" +
        createHash("sha256").update(dir).digest("hex").slice(0, 10) +
        "-mcp",
      restart: "unless-stopped",
      init: true,
      user: `${manifest.uid}:${manifest.gid}`,
      environment: {
        WATERLOO_AUTH_MODE: "portable",
        WATERLOO_ORIGIN: u.origin,
        WATERLOO_OWNER_EMAIL: u.owner,
        D2L_USERNAME: u.username,
        WATERLOO_SERVICE: "1",
        WATERLOO_BIND: "0.0.0.0",
        PORT: "8000",
        WATERLOO_STATE_DIR: "/state",
        WATERLOO_SECRETS_DIR: "/run/secrets",
        D2L_SESSION_DIR: "/state/sessions",
        HOME: "/tmp",
      },
      ports: [`127.0.0.1:${u.port}:8000`],
      read_only: true,
      shm_size: "1gb",
      tmpfs: ["/tmp:size=768m,mode=1777"],
      mem_limit: "2g",
      cpus: 2,
      pids_limit: 512,
      volumes: [
        {
          type: "bind",
          source: path.join(home, "private/state"),
          target: "/state",
        },
        {
          type: "bind",
          source: path.join(home, "private/secrets"),
          target: "/run/secrets",
          read_only: true,
        },
      ],
      security_opt: ["no-new-privileges:true"],
      cap_drop: ["ALL"],
      networks: [u.id],
    };
    if (u.racket) {
      const runner = "racket_" + u.id,
        network = u.id + "_racket";
      networks[network] = { internal: true };
      services[u.id].environment.WATERLOO_RACKET_URL =
        "http://" + runner + ":8010";
      services[u.id].networks.push(network);
      services[runner] = {
        build: { context: path.join(sourceRoot, "racket-runner") },
        restart: "unless-stopped",
        init: true,
        user: "65534:65534",
        read_only: true,
        tmpfs: ["/tmp:size=32m,mode=1777"],
        mem_limit: "512m",
        cpus: 1,
        pids_limit: 64,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        networks: [network],
        healthcheck: {
          test: [
            "CMD",
            "python3",
            "-c",
            "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/health', timeout=2)",
          ],
          interval: "10s",
          timeout: "3s",
          retries: 5,
        },
      };
    }
  }
  return {
    name:
      "waterloo-host-" +
      createHash("sha256").update(dir).digest("hex").slice(0, 10),
    services,
    networks,
  };
}
export async function renderHost(dir, sourceRoot = root) {
  const m = await loadHost(dir);
  await save(path.join(dir, "compose.json"), composeFor(dir, m, sourceRoot));
  const caddy = m.users
    .filter((u) => new URL(u.origin).protocol === "https:")
    .map((u) => `${u.origin} {\n  reverse_proxy 127.0.0.1:${u.port}\n}`)
    .join("\n\n");
  await writeFile(
    path.join(dir, "Caddyfile"),
    "# Install Caddy on this host and configure DNS before using this file.\n" +
      caddy +
      "\n",
    { mode: 0o600 },
  );
}
export async function addHostUser(dir, input, sourceRoot = root) {
  const u = userSchema.parse(input),
    m = await loadHost(dir);
  if (m.mode === "single" && m.users.length)
    throw new Error("HOST_SINGLE_USER_LIMIT");
  const config = readConfig({
    WATERLOO_AUTH_MODE: "portable",
    WATERLOO_ORIGIN: u.origin,
    WATERLOO_OWNER_EMAIL: u.owner,
    D2L_USERNAME: u.username,
  });
  u.origin = config.origin;
  validateLocalPort(u);
  u.owner = u.owner.toLowerCase();
  u.username = u.username.toLowerCase();
  if (
    m.users.some((p) =>
      ["id", "port", "owner", "username"].some((k) => p[k] === u[k]),
    )
  )
    throw new Error("HOST_DUPLICATE_USER_CONFIG");
  if (
    m.users.some(
      (p) => new URL(p.origin).hostname === new URL(u.origin).hostname,
    )
  )
    throw new Error("HOST_SHARED_COOKIE_HOST");
  const home = userHome(dir, u.id);
  await mkdir(path.join(dir, "users"), { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 }); // Refuse reuse, including an incomplete prior setup.
  for (const p of [
    "private",
    "private/state",
    "private/state/downloads",
    "private/secrets",
    "private/clients",
  ])
    await mkdir(path.join(home, p), { mode: 0o700 });
  const secrets = path.join(home, "private/secrets");
  await writeFile(
    path.join(secrets, "session-key"),
    randomBytes(32).toString("hex"),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(path.join(secrets, "clients.json"), "[]\n", {
    mode: 0o600,
    flag: "wx",
  });
  await provisionOwner(secrets, path.join(home, "private/owner.token"));
  await writeFile(
    path.join(home, ".env"),
    `WATERLOO_AUTH_MODE=portable\nWATERLOO_ORIGIN=${u.origin}\nWATERLOO_OWNER_EMAIL=${u.owner}\nD2L_USERNAME=${u.username}\nPORT=${u.port}\n`,
    { mode: 0o600, flag: "wx" },
  );
  if (process.getuid?.() === 0) {
    const own = async (p) => {
      const s = await lstat(p);
      if (s.isSymbolicLink()) throw new Error("HOST_SYMLINK_REJECTED");
      await chown(p, m.uid, m.gid);
      if (s.isDirectory())
        for (const name of await readdir(p)) await own(path.join(p, name));
    };
    await own(path.join(home, "private/state"));
    await own(secrets);
  }
  m.users.push(u);
  await save(path.join(dir, "host.json"), m);
  await renderHost(dir, sourceRoot);
  return {
    id: u.id,
    origin: u.origin,
    ownerKeyFile: path.join(home, "private/owner.token"),
  };
}
const stable = (v) =>
  JSON.stringify(v, (_, value) =>
    value && !Array.isArray(value) && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort())
      : value,
  );
export async function auditHost(dir, sourceRoot = root) {
  const checks = [];
  const check = (code, ok, users = []) => checks.push({ code, ok, users });
  let m;
  try {
    m = await loadHost(dir);
    check("UNIQUE_IDENTITIES_AND_COOKIE_HOSTS", true);
  } catch {
    return {
      scope: "configured-files",
      passed: false,
      users: 0,
      checksPassed: 0,
      checksTotal: 1,
      findings: [{ code: "HOST_MANIFEST_INVALID", users: [] }],
    };
  }
  try {
    check(
      "EXACT_ISOLATED_COMPOSE",
      stable(
        JSON.parse(await readFile(path.join(dir, "compose.json"), "utf8")),
      ) === stable(composeFor(dir, m, sourceRoot)),
    );
  } catch {
    check("EXACT_ISOLATED_COMPOSE", false);
  }
  const keys = new Map(),
    paths = new Map();
  for (const u of m.users) {
    const home = userHome(dir, u.id);
    for (const rel of ["", "private", "private/state", "private/secrets"]) {
      const p = path.join(home, rel);
      try {
        const s = await lstat(p),
          resolved = await realpath(p);
        check(
          "PRIVATE_REAL_DIRECTORY",
          s.isDirectory() &&
            !s.isSymbolicLink() &&
            resolved === p &&
            (s.mode & 0o077) === 0,
          [u.id],
        );
        check(
          "DISTINCT_DIRECTORY",
          !paths.has(resolved),
          [u.id, paths.get(resolved)].filter(Boolean),
        );
        paths.set(resolved, u.id);
      } catch {
        check("PRIVATE_REAL_DIRECTORY", false, [u.id]);
      }
    }
    const secrets = path.join(home, "private/secrets");
    const unique = (material, label) => {
      const hash = createHash("sha256").update(material).digest("hex");
      check(label, !keys.has(hash), [u.id, keys.get(hash)].filter(Boolean));
      keys.set(hash, u.id);
    };
    try {
      for (const file of ["session-key", "owner-auth.json", "clients.json"]) {
        const s = await lstat(path.join(secrets, file));
        check(
          "PRIVATE_REGULAR_SECRET",
          s.isFile() &&
            !s.isSymbolicLink() &&
            s.nlink === 1 &&
            (s.mode & 0o077) === 0,
          [u.id],
        );
      }
      const key = (
        await readFile(path.join(secrets, "session-key"), "utf8")
      ).trim();
      check("VALID_ENCRYPTION_KEY", /^[a-f0-9]{64}$/.test(key), [u.id]);
      unique(key, "DISTINCT_ENCRYPTION_KEY");
      try {
        const file = path.join(secrets, "authenticator-key");
        const s = await lstat(file);
        check(
          "PRIVATE_REGULAR_SECRET",
          s.isFile() &&
            !s.isSymbolicLink() &&
            s.nlink === 1 &&
            (s.mode & 0o077) === 0,
          [u.id],
        );
        const key = (await readFile(file, "utf8")).trim();
        check("VALID_AUTHENTICATOR_KEY", /^[a-f0-9]{64}$/.test(key), [u.id]);
        unique(key, "DISTINCT_AUTHENTICATOR_KEY");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const owner = JSON.parse(
        await readFile(path.join(secrets, "owner-auth.json"), "utf8"),
      );
      check(
        "VALID_OWNER_AUTH",
        /^[a-f0-9]{64}$/.test(owner.sessionKey) &&
          /^[a-f0-9]{64}$/.test(owner.tokenHash),
        [u.id],
      );
      unique(owner.sessionKey, "DISTINCT_COOKIE_KEY");
      unique(owner.tokenHash, "DISTINCT_OWNER_KEY");
      const clients = JSON.parse(
        await readFile(path.join(secrets, "clients.json"), "utf8"),
      );
      for (const c of clients.filter((c) => c.enabled)) {
        check("HASHED_AGENT_TOKEN", /^[a-f0-9]{64}$/.test(c.tokenHash), [u.id]);
        unique(c.tokenHash ?? "", "DISTINCT_AGENT_TOKEN");
      }
    } catch {
      check("READABLE_PRIVATE_KEYS", false, [u.id]);
    }
  }
  const findings = checks
    .filter((c) => !c.ok)
    .map(({ code, users }) => ({ code, users }));
  return {
    scope: "configured-files",
    passed: !findings.length,
    users: m.users.length,
    checksPassed: checks.length - findings.length,
    checksTotal: checks.length,
    findings,
  };
}

export async function auditRunningHost(
  dir,
  containers,
  sourceRoot = root,
  networks = [],
) {
  const m = await loadHost(dir),
    expected = composeFor(dir, m, sourceRoot),
    findings = [];
  let checks = 0;
  const check = (code, ok, id) => {
    checks++;
    if (!ok) findings.push({ code, users: id ? [id] : [] });
  };
  check(
    "EXACT_RUNNING_USER_COUNT",
    containers.length === Object.keys(expected.services).length,
  );
  for (const [serviceId, service] of Object.entries(expected.services)) {
    const u = m.users.find(
      (u) => serviceId === u.id || serviceId === "racket_" + u.id,
    );
    const isRunner = serviceId !== u.id;
    const matches = containers.filter(
      (c) =>
        c.Config?.Labels?.["com.docker.compose.service"] === serviceId &&
        c.Config.Labels["com.docker.compose.project"] === expected.name,
    );
    check(
      "USER_CONTAINER_RUNNING",
      matches.length === 1 && matches[0].State?.Running,
      u.id,
    );
    if (matches.length !== 1) continue;
    if (isRunner)
      check(
        "RACKET_INTERNAL_NETWORK",
        networks.some(
          (n) =>
            n.Name === expected.name + "_" + u.id + "_racket" &&
            n.Internal === true,
        ),
        u.id,
      );
    const c = matches[0],
      h = c.HostConfig;
    check(
      "UNPRIVILEGED_PROCESS",
      !h.Privileged &&
        c.Config.User === service.user &&
        h.ReadonlyRootfs &&
        h.CapDrop?.includes("ALL") &&
        h.SecurityOpt?.some((s) =>
          /^no-new-privileges(?::true|=true)?$/.test(s),
        ),
      u.id,
    );
    const mounts = c.Mounts.filter((v) => v.Type !== "tmpfs");
    check(
      "EXACT_PRIVATE_MOUNTS",
      mounts.length === (service.volumes ?? []).length &&
        (service.volumes ?? []).every((v) =>
          mounts.some(
            (p) =>
              p.Type === "bind" &&
              p.Source === v.source &&
              p.Destination === v.target &&
              p.RW === !v.read_only,
          ),
        ),
      u.id,
    );
    check(
      "PRIVATE_PROCESS_AND_NETWORK",
      !h.PidMode &&
        !h.UTSMode &&
        h.IpcMode !== "host" &&
        service.networks.some(
          (n) => h.NetworkMode === expected.name + "_" + n,
        ) &&
        Object.keys(c.NetworkSettings.Networks).length ===
          service.networks.length &&
        service.networks.every((n) =>
          Object.hasOwn(c.NetworkSettings.Networks, expected.name + "_" + n),
        ),
      u.id,
    );
    const bindings = h.PortBindings ?? {},
      ports = bindings["8000/tcp"] ?? [];
    check(
      "LOOPBACK_ONLY_PORT",
      isRunner
        ? Object.keys(bindings).length === 0
        : Object.keys(bindings).length === 1 &&
            ports.length === 1 &&
            ports[0].HostIp === "127.0.0.1" &&
            ports[0].HostPort === String(u.port),
      u.id,
    );
    check(
      "BOUNDED_RESOURCES",
      h.Memory > 0 && h.PidsLimit > 0 && h.NanoCpus > 0,
      u.id,
    );
  }
  return {
    scope: "running-containers",
    passed: !findings.length,
    users: m.users.length,
    checksPassed: checks - findings.length,
    checksTotal: checks,
    findings,
  };
}
