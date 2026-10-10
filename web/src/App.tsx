import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { z } from "zod";
import { api, type AuthStatus } from "./api/client";

const credentials = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(10).max(72),
});

const passwordChange = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(10).max(72),
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
};

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <h1 className="p-6 text-xl font-semibold">Garage UI</h1>
      <div className="max-w-sm px-6 pb-10">{children}</div>
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
        className="mt-1 w-full border border-neutral-300 px-2 py-1"
        type={type}
        autoComplete={autoComplete}
        {...registration}
      />
    </label>
  );
}

function ErrorText({ message }: { message: string | undefined }) {
  if (!message) {
    return null;
  }
  return <p className="text-sm text-red-700">{message}</p>;
}

function SetupForm() {
  const client = useQueryClient();
  const form = useForm<Credentials>({ resolver: zodResolver(credentials) });
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
        label="Username"
        type="text"
        autoComplete="username"
        registration={form.register("username")}
      />
      <Field
        label="Password"
        type="password"
        autoComplete="new-password"
        registration={form.register("password")}
      />
      <ErrorText message={setup.error instanceof Error ? setup.error.message : undefined} />
      <button className="border border-neutral-900 px-3 py-1 text-left" type="submit">
        Create administrator
      </button>
    </form>
  );
}

function LoginForm() {
  const client = useQueryClient();
  const form = useForm<Credentials>({ resolver: zodResolver(credentials) });
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
        label="Username"
        type="text"
        autoComplete="username"
        registration={form.register("username")}
      />
      <Field
        label="Password"
        type="password"
        autoComplete="current-password"
        registration={form.register("password")}
      />
      <ErrorText message={login.error instanceof Error ? login.error.message : undefined} />
      <button className="border border-neutral-900 px-3 py-1 text-left" type="submit">
        Log in
      </button>
    </form>
  );
}

function Home({ status }: { status: SessionStatus }) {
  const client = useQueryClient();
  const health = useQuery({
    queryKey: ["healthz"],
    queryFn: () => api<Health>("/healthz"),
  });
  const form = useForm<PasswordChange>({ resolver: zodResolver(passwordChange) });
  const change = useMutation({
    mutationFn: (input: PasswordChange) =>
      api("/api/auth/change-password", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      form.reset();
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
  return (
    <div className="grid gap-6">
      {status.garage_write_blocked === true ? (
        <p role="alert">Garage v2.3.0 or newer is required</p>
      ) : null}
      <p>
        {status.username} · {status.role}
      </p>
      <p>{healthText}</p>
      <form
        className="grid gap-3"
        onSubmit={form.handleSubmit((input) => change.mutate(input))}
      >
        <label className="block">
          <span className="text-sm">Current password</span>
          <input
            className="mt-1 w-full border border-neutral-300 px-2 py-1"
            type="password"
            autoComplete="current-password"
            {...form.register("current_password")}
          />
        </label>
        <label className="block">
          <span className="text-sm">New password</span>
          <input
            className="mt-1 w-full border border-neutral-300 px-2 py-1"
            type="password"
            autoComplete="new-password"
            {...form.register("new_password")}
          />
        </label>
        <ErrorText message={change.isSuccess ? "Password updated" : undefined} />
        <ErrorText message={change.error instanceof Error ? change.error.message : undefined} />
        <button className="border border-neutral-900 px-3 py-1 text-left" type="submit">
          Change password
        </button>
      </form>
      <button
        className="border border-neutral-900 px-3 py-1 text-left"
        type="button"
        onClick={() => logout.mutate()}
      >
        Log out
      </button>
    </div>
  );
}

export function App() {
  const status = useQuery({
    queryKey: ["auth", "status"],
    queryFn: () => api<SessionStatus>("/api/auth/status"),
  });
  if (status.isPending) {
    return (
      <Shell>
        <p>checking</p>
      </Shell>
    );
  }
  if (status.isError || !status.data) {
    return (
      <Shell>
        <p>unavailable</p>
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
    <Shell>
      <Home status={status.data} />
    </Shell>
  );
}
