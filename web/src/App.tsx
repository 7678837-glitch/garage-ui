import { zodResolver } from "@hookform/resolvers/zod";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type Query,
  type QueryCache,
  type QueryCacheNotifyEvent,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { z } from "zod";
import { api, bindUnauthenticated, type AuthStatus } from "./api/client";
import { isGarageDown } from "./garageDown";
import { About, garageLine } from "./About";
import { AdminTokens } from "./AdminTokens";
import { Audit } from "./Audit";
import { BlockErrors } from "./BlockErrors";
import { Buckets } from "./Buckets";
import { ClusterHealth } from "./ClusterHealth";
import { ClusterNodes } from "./ClusterNodes";
import type { CopyKey } from "./copy-en";
import { LanguageChooser, phrase, useI18n, copy } from "./i18n";
import { Keys } from "./Keys";
import {
  Nav,
  bucketLocationFromHash,
  detailAddressFromHash,
  detailTabCopyKey,
  sectionCopyKey,
  sectionForDetail,
  sectionFromHash,
  useLocationHash,
  type SectionId,
} from "./Nav";
import { ThemeChooser } from "./theme";
import { releaseHash, savePhase, saveStatus, setFormDirty } from "./unsaved";
import { Users } from "./Users";
import { Workers } from "./Workers";

const passwordBounds = "ui.password.must.be.10.to.72.characters";

const credentials = z.object({
  username: z.string().min(1, "ui.username.is.required").max(64, "ui.username.is.invalid"),
  password: z.string().min(10, passwordBounds).max(72, passwordBounds),
});

const passwordChange = z.object({
  current_password: z.string().min(1, "ui.current.password.is.required"),
  new_password: z.string().min(10, passwordBounds).max(72, passwordBounds),
});

type Credentials = z.infer<typeof credentials>;
type PasswordChange = z.infer<typeof passwordChange>;

type Health = {
  status: string;
  version: string;
};

type SessionStatus = AuthStatus & {
  garage_version: string | null;
  garage_write_blocked: boolean;
  tls_insecure?: boolean;
};

function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const width = wide ? "max-w-5xl px-6 pb-10" : "max-w-sm px-6 pb-10";
  return (
    <main className="min-h-screen bg-canvas text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 p-6">
        <h1 className="text-xl font-semibold">{copy("ui.garage.ui")}</h1>
        <ThemeChooser />
      </header>
      <div className={width}>{children}</div>
    </main>
  );
}

function Field({
  label,
  type,
  autoComplete,
  registration,
}: {
  label: string;
  type: string;
  autoComplete: string;
  registration: UseFormRegisterReturn;
}) {
  return (
    <label className="block">
      <span className="text-sm">{label}</span>
      <input
        className="mt-1 w-full border border-line px-2 py-1"
        type={type}
        autoComplete={autoComplete}
        {...registration}
      />
    </label>
  );
}

function ErrorText({ message }: { message: string | undefined }) {
  const { language } = useI18n();
  if (!message) {
    return null;
  }
  return <p className="text-sm text-danger">{phrase(language, message)}</p>;
}

function SetupForm() {
  const client = useQueryClient();
  const form = useForm<Credentials>({ resolver: zodResolver(credentials) });
  const { errors } = form.formState;
  const setup = useMutation({
    mutationFn: (input: Credentials) =>
      api("/api/setup", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["auth", "status"] });
    },
  });
  return (
    <form
      className="grid gap-3"
      onSubmit={form.handleSubmit((input) => setup.mutate(input))}
    >
      <Field
        label={copy("ui.username")}
        type="text"
        autoComplete="username"
        registration={form.register("username")}
      />
      <ErrorText message={errors.username?.message} />
      <Field
        label={copy("ui.password")}
        type="password"
        autoComplete="new-password"
        registration={form.register("password")}
      />
      <ErrorText message={errors.password?.message} />
      <ErrorText message={setup.error instanceof Error ? setup.error.message : undefined} />
      <button
        className="border border-ink px-3 py-1 text-left"
        type="submit"
        disabled={setup.isPending}
      >
        {setup.isPending ? copy("ui.creating.administrator") : copy("ui.create.administrator")}
      </button>
    </form>
  );
}

function LoginForm() {
  const client = useQueryClient();
  const { t } = useI18n();
  const form = useForm<Credentials>({ resolver: zodResolver(credentials) });
  const { errors } = form.formState;
  const login = useMutation({
    mutationFn: (input: Credentials) =>
      api("/api/auth/login", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["auth", "status"] });
    },
  });
  return (
    <form
      className="grid gap-3"
      onSubmit={form.handleSubmit((input) => login.mutate(input))}
    >
      <Field
        label={copy("ui.username")}
        type="text"
        autoComplete="username"
        registration={form.register("username")}
      />
      <ErrorText message={errors.username?.message} />
      <Field
        label={copy("ui.password")}
        type="password"
        autoComplete="current-password"
        registration={form.register("password")}
      />
      <ErrorText message={errors.password?.message} />
      <ErrorText message={login.error instanceof Error ? login.error.message : undefined} />
      <button
        className="border border-ink px-3 py-1 text-left"
        type="submit"
        disabled={login.isPending}
      >
        {login.isPending ? t("auth.loggingIn") : t("auth.logIn")}
      </button>
    </form>
  );
}

function useHashSection(role: string) {
  const [hash, assignHash] = useLocationHash();
  const select = (id: SectionId) => {
    const next = `#${id}`;
    if (!releaseHash(next)) {
      return;
    }
    assignHash(next);
  };
  return { hash, section: sectionFromHash(hash, role), select };
}

type Crumb =
  | { kind: "link"; id: SectionId; label: string }
  | { kind: "current"; label: string };

function breadcrumbCrumbs(
  section: SectionId,
  hash: string,
  label: (key: CopyKey) => string,
): Crumb[] {
  const detail = detailAddressFromHash(hash);
  if (detail && section === sectionForDetail(detail.resource)) {
    const parent = sectionForDetail(detail.resource);
    return [
      { kind: "link", id: "overview", label: label(sectionCopyKey("overview")) },
      { kind: "link", id: parent, label: label(sectionCopyKey(parent)) },
      { kind: "current", label: label(detailTabCopyKey(detail)) },
    ];
  }
  const objects = section === "buckets" && bucketLocationFromHash(hash).kind === "objects";
  if (objects) {
    return [
      { kind: "link", id: "overview", label: label(sectionCopyKey("overview")) },
      { kind: "link", id: "buckets", label: label(sectionCopyKey("buckets")) },
      { kind: "current", label: label("nav.objects") },
    ];
  }
  if (section === "overview") {
    return [{ kind: "current", label: label(sectionCopyKey("overview")) }];
  }
  return [
    { kind: "link", id: "overview", label: label(sectionCopyKey("overview")) },
    { kind: "current", label: label(sectionCopyKey(section)) },
  ];
}

export function Breadcrumb({
  section,
  hash,
  onSelect,
}: {
  section: SectionId;
  hash: string;
  onSelect: (id: SectionId) => void;
}) {
  const { t } = useI18n();
  const crumbs = breadcrumbCrumbs(section, hash, t);
  return (
    <nav aria-label={t("nav.breadcrumb")} className="flex flex-wrap items-center gap-2">
      {crumbs.map((crumb, index) => (
        <span
          key={crumb.kind === "link" ? crumb.id : "current"}
          className="flex items-center gap-2"
        >
          {index > 0 ? <span aria-hidden="true">/</span> : null}
          {crumb.kind === "link" ? (
            <a
              href={`#${crumb.id}`}
              className="underline"
              onClick={(event) => {
                // The href only provides the link role. Clicks must call select so the unsaved-leave confirmation still applies.
                event.preventDefault();
                onSelect(crumb.id);
              }}
            >
              {crumb.label}
            </a>
          ) : (
            <span aria-current="page">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function queryIsGarageDown(query: Query): boolean {
  return isGarageDown(query.state.error) || isGarageDown(query.state.fetchFailureReason);
}

function rememberGarageQuery(held: Set<string>, query: Query) {
  if (queryIsGarageDown(query)) {
    held.add(query.queryHash);
    return;
  }
  if (query.state.fetchStatus === "idle") {
    held.delete(query.queryHash);
  }
}

function garageBannerOn(cache: QueryCache, held: ReadonlySet<string>): boolean {
  if (cache.getAll().some(queryIsGarageDown)) {
    return true;
  }
  for (const hash of held) {
    const query = cache.get(hash);
    if (query && query.state.fetchStatus !== "idle") {
      return true;
    }
  }
  return false;
}

function GarageBanner() {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  // A fetch with no data clears error and fetchFailureReason, and error stays null through the retry gap.
  // Reading only state.error would drop the banner in both of those windows. Remember queries that are not idle yet.
  const held = useRef(new Set<string>());
  // The banner reads the whole query cache. A subscription to only this component's query would miss other sections.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      for (const query of cache.getAll()) {
        rememberGarageQuery(held.current, query);
      }
      return cache.subscribe((event: QueryCacheNotifyEvent) => {
        if (event.type === "removed") {
          held.current.delete(event.query.queryHash);
        } else {
          rememberGarageQuery(held.current, event.query);
        }
        onStoreChange();
      });
    },
    [cache],
  );
  const down = useSyncExternalStore(subscribe, () => garageBannerOn(cache, held.current));
  if (!down) {
    return null;
  }
  return (
    <>
      <p role="alert">{copy("ui.garage.admin.api.is.not.reachable")}</p>
      <button
        className="border border-ink px-3 py-1 text-left"
        type="button"
        onClick={() => {
          void client.refetchQueries({
            type: "all",
            predicate: (query) => queryIsGarageDown(query),
          });
        }}
      >
        {copy("ui.retry")}</button>
    </>
  );
}

function Home({ status }: { status: SessionStatus }) {
  const client = useQueryClient();
  const { t } = useI18n();
  const health = useQuery({
    queryKey: ["healthz"],
    queryFn: () => api<Health>("/healthz"),
  });
  const { hash, section, select } = useHashSection(status.role ?? "");
  // A narrow viewport decides only the initial collapsed state. A resize listener would close Menu again after the user opens it.
  const [menuOpen, setMenuOpen] = useState(() => {
    if (typeof window.matchMedia !== "function") {
      return true;
    }
    return !window.matchMedia("(max-width: 639px)").matches;
  });
  const form = useForm<PasswordChange>({
    resolver: zodResolver(passwordChange),
    defaultValues: { current_password: "", new_password: "" },
  });
  const { errors } = form.formState;
  const currentPassword = form.watch("current_password") ?? "";
  const newPassword = form.watch("new_password") ?? "";
  const passwordDirty = currentPassword.length > 0 || newPassword.length > 0;
  useEffect(() => {
    // The password form mounts only on Settings. This effect lives on Home, so leaving Settings has to clear the dirty flag itself.
    setFormDirty("password", section === "settings" && passwordDirty);
    return () => setFormDirty("password", false);
  }, [passwordDirty, section]);
  const change = useMutation({
    mutationFn: (input: PasswordChange) =>
      api("/api/auth/change-password", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      form.reset({ current_password: "", new_password: "" });
    },
  });
  const logout = useMutation({
    mutationFn: () => api("/api/auth/logout", { method: "POST" }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["auth", "status"] });
    },
  });
  let healthText = "checking";
  if (health.isSuccess) {
    healthText = `${health.data.status} · ${health.data.version}`;
  } else if (health.isError) {
    healthText = "unavailable";
  }
  const passwordPhase = savePhase(change.isPending, change.isError, change.isSuccess);
  const passwordStatus = saveStatus(passwordPhase, passwordDirty, copy("ui.password.updated"));
  const admin = status.role === "admin";
  // An admin ignores the download bit. A read-only user sees preview and download only when that bit is set.
  const canTransfer = admin || status.can_download === true;
  return (
    <div className="flex flex-col gap-6 sm:flex-row">
      <Nav
        role={status.role ?? ""}
        section={section}
        open={menuOpen}
        onToggle={() => setMenuOpen((open) => !open)}
        onSelect={select}
      />
      <div className="grid min-w-0 flex-1 gap-6">
        <GarageBanner />
        <p
          className="inline-block w-fit border border-ink px-2 py-0.5"
          role="status"
          aria-label={copy("ui.health.status")}
        >
          {healthText}
        </p>
        <p>
          {status.username} · {status.role}
        </p>
        <p>{garageLine(status.garage_version)}</p>
        <Breadcrumb section={section} hash={hash} onSelect={select} />
        {section === "overview" ? (
          <>
            <div className="grid max-w-sm gap-6">
              {status.garage_write_blocked === true ? (
                <p role="alert">{copy("ui.garage.v2.3.0.or.newer.is.required")}</p>
              ) : null}
              {status.tls_insecure === true ? (
                <p role="alert">{copy("ui.tls.certificate.verification.is.off")}</p>
              ) : null}
              <button
                className="border border-ink px-3 py-1 text-left"
                type="button"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
              >
                {logout.isPending ? t("auth.loggingOut") : t("auth.logOut")}
              </button>
            </div>
            {admin ? <ClusterHealth /> : null}
          </>
        ) : null}
        {section === "nodes" && admin ? <ClusterNodes /> : null}
        {section === "workers" && admin ? <Workers /> : null}
        {section === "block-errors" && admin ? <BlockErrors /> : null}
        {section === "audit" && admin ? <Audit /> : null}
        {section === "settings" ? (
          <>
            <LanguageChooser />
            <form
              className="grid max-w-sm gap-3"
              onSubmit={form.handleSubmit((input) => change.mutate(input))}
            >
              <label className="block">
                <span className="text-sm">{copy("ui.current.password")}</span>
                <input
                  className="mt-1 w-full border border-line px-2 py-1"
                  type="password"
                  autoComplete="current-password"
                  {...form.register("current_password")}
                />
              </label>
              <ErrorText message={errors.current_password?.message} />
              <label className="block">
                <span className="text-sm">{copy("ui.new.password")}</span>
                <input
                  className="mt-1 w-full border border-line px-2 py-1"
                  type="password"
                  autoComplete="new-password"
                  {...form.register("new_password")}
                />
              </label>
              <ErrorText message={errors.new_password?.message} />
              <ErrorText
                message={change.error instanceof Error ? change.error.message : undefined}
              />
              {passwordStatus ? <p>{passwordStatus}</p> : null}
              <button
                className="border border-ink px-3 py-1 text-left"
                type="submit"
                disabled={change.isPending}
              >
                {copy("ui.change.password")}</button>
            </form>
            <About garageVersion={status.garage_version} />
          </>
        ) : null}
        {section === "buckets" ? (
          <Buckets canManage={admin} canWrite={admin} canTransfer={canTransfer} />
        ) : null}
        {section === "keys" ? <Keys canManage={admin} /> : null}
        {section === "users" && admin && status.username ? (
          <Users selfUsername={status.username} />
        ) : null}
        {section === "tokens" && admin ? <AdminTokens /> : null}
      </div>
    </div>
  );
}

function clearSignedIn(client: QueryClient): void {
  client.setQueryData<SessionStatus>(["auth", "status"], (current) => {
    if (!current) {
      return current;
    }
    return {
      ...current,
      authenticated: false,
      username: null,
      role: null,
      can_download: null,
      can_share: null,
    };
  });
}

export function App() {
  const client = useQueryClient();
  // A child request can return before the effect runs. Attach the hook before useQuery, and detach it on unmount.
  bindUnauthenticated(() => clearSignedIn(client));
  useEffect(() => {
    bindUnauthenticated(() => clearSignedIn(client));
    return () => bindUnauthenticated(null);
  }, [client]);
  const status = useQuery({
    queryKey: ["auth", "status"],
    queryFn: () => api<SessionStatus>("/api/auth/status"),
  });
  if (status.isPending) {
    return (
      <Shell>
        <p>{copy("ui.checking")}</p>
      </Shell>
    );
  }
  if (status.isError || !status.data) {
    return (
      <Shell>
        <p>{copy("ui.unavailable")}</p>
      </Shell>
    );
  }
  if (!status.data.initialized) {
    return (
      <Shell>
        <SetupForm />
      </Shell>
    );
  }
  if (!status.data.authenticated) {
    return (
      <Shell>
        <LoginForm />
      </Shell>
    );
  }
  return (
    <Shell wide>
      <Home status={status.data} />
    </Shell>
  );
}

const UNRESERVED = /[A-Za-z0-9._~-]/;

export function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeSegment).join("/");
}

export function decodeObjectKey(encoded: string): string {
  const bytes: number[] = [];
  const segments = encoded.split("/");
  segments.forEach((segment, index) => {
    if (index > 0) {
      bytes.push(0x2f);
    }
    decodeSegment(segment, bytes);
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
}

export function folderNameAllowed(name: string): boolean {
  if (name.includes("/")) {
    return false;
  }
  for (const character of name) {
    const code = character.codePointAt(0);
    if (code === undefined || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return false;
    }
  }
  return true;
}

function encodeSegment(segment: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(segment)) {
    const character = String.fromCharCode(byte);
    if (UNRESERVED.test(character)) {
      out += character;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function decodeSegment(segment: string, bytes: number[]) {
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] !== "%") {
      bytes.push(segment.charCodeAt(index));
      continue;
    }
    const hex = segment.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      throw new Error("bad object key");
    }
    bytes.push(Number.parseInt(hex, 16));
    index += 2;
  }
}
