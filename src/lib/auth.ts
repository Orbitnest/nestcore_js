import type { HttpClient } from './client';
import type {
  AuthSession,
  AuthUser,
  SignUpCredentials,
  SignInCredentials,
  PasswordRecoveryOptions,
  PasswordResetOptions,
  UpdateUserOptions,
  ApiResult,
  PasskeyDevice,
  PasskeyRegistrationOptions,
  PasskeyAuthenticationOptions,
  PasskeyRegisterVerifyOptions,
  PasskeyAuthenticateVerifyOptions,
  PasskeySignUpOptions,
  PasskeySignUpVerifyOptions,
} from '../types';
import type { StorageAdapter } from './storage-adapters';
import { memoryAdapter } from './storage-adapters';

/** Returned by `signIn` when the account has MFA enrolled — complete with `verifyMfa`. */
export interface MfaChallenge {
  mfa_required: true;
  challenge_token: string;
  factors: Array<{ id: string; type: string }>;
}

/** An enrolled MFA factor. */
export interface MfaFactor {
  id: string;
  factor_type: string;
  friendly_name?: string | null;
  verified: boolean;
  created_at: string;
  last_used_at?: string | null;
}

/** Type guard: did `signIn` return an MFA challenge instead of a session? */
export function isMfaChallenge(value: unknown): value is MfaChallenge {
  return !!value && typeof value === 'object' && (value as MfaChallenge).mfa_required === true;
}

const SESSION_KEY = 'orbitnest.session';
/** Refresh the access token this many seconds before it expires. */
const REFRESH_MARGIN_S = 30;
const NO_SESSION = { data: null, error: { message: 'No active session', code: 'NO_SESSION' } } as const;

export class AuthClient {
  private _session: AuthSession | null = null;
  private readonly storage: StorageAdapter;
  private readonly storageKey: string;
  private refreshing: Promise<ApiResult<AuthSession>> | null = null;
  private readonly listeners = new Set<(session: AuthSession | null) => void>();

  constructor(private client: HttpClient, options: { storage?: StorageAdapter } = {}) {
    // memoryAdapter persists nothing: without an adapter the session stays in
    // this instance only (never shared between SSR requests).
    this.storage = options.storage ?? memoryAdapter;
    // Namespace the persisted session by project so multiple clients on the
    // same origin don't clobber each other.
    this.storageKey = `${SESSION_KEY}.${this.client.getProjectSlug()}`;
    // Rehydrate a previously persisted session (browser refresh).
    const raw = this.storage.getItem(this.storageKey);
    if (raw) {
      try {
        this._session = JSON.parse(raw) as AuthSession;
      } catch {
        this.storage.removeItem(this.storageKey);
      }
    }
  }

  // Reading/writing `this.session` transparently persists to the configured
  // storage adapter, so every existing assignment below stays sync-on-write.
  private get session(): AuthSession | null {
    return this._session;
  }
  private set session(value: AuthSession | null) {
    this._session = withExpiry(value);
    try {
      if (value) this.storage.setItem(this.storageKey, JSON.stringify(this._session));
      else this.storage.removeItem(this.storageKey);
    } catch {
      /* storage is best-effort */
    }
    for (const cb of this.listeners) {
      try { cb(this._session); } catch { /* listener errors must not break auth */ }
    }
  }

  /**
   * Listen for session changes (sign-in, token refresh, sign-out). Returns an
   * unsubscribe function.
   */
  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  /**
   * The current access token, refreshed first when it is about to expire.
   * Returns null when signed out or when the server rejected the refresh. A
   * transient refresh failure keeps the old token, so the request fails with
   * 401 instead of silently running as the anonymous role.
   */
  async getAccessToken(): Promise<string | null> {
    const s = this.session;
    if (!s?.access_token) return null;
    if (s.expires_at && s.expires_at - REFRESH_MARGIN_S <= Date.now() / 1000) {
      const refreshed = await this.refreshSession();
      return refreshed.data?.access_token ?? this.session?.access_token ?? null;
    }
    return s.access_token;
  }

  /**
   * Called after the API rejected `staleToken` (401): refresh once and return
   * the new access token, or null when the session can't be renewed. Calls
   * that raced an earlier refresh just get the current token.
   */
  async refreshAccessToken(staleToken: string): Promise<string | null> {
    const current = this.session?.access_token;
    if (!current) return null;
    if (current !== staleToken) return current;
    return (await this.refreshSession()).data?.access_token ?? null;
  }

  private async withToken<T>(fn: (token: string) => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    const token = await this.getAccessToken();
    return token ? fn(token) : NO_SESSION;
  }

  private get basePath(): string {
    return `/api/projects/${this.client.getProjectSlug()}/auth`;
  }

  /**
   * Get the current session
   */
  getSession(): AuthSession | null {
    return this.session;
  }

  /**
   * Get the current user
   */
  getUser(): AuthUser | null {
    return this.session?.user || null;
  }

  /**
   * Sign up with email and password - Step 1: Request OTP
   * This sends an OTP to the user's email for verification
   */
  async signUp(credentials: SignUpCredentials): Promise<ApiResult<{ success: boolean; message: string; email: string; expires_in: number }>> {
    const result = await this.client.requestPublic<{ success: boolean; message: string; email: string; expires_in: number }>(`${this.basePath}/signup`, {
      method: 'POST',
      body: {
        email: credentials.email,
        password: credentials.password,
        user_metadata: credentials.metadata,
      },
    });

    // Note: No session is returned in step 1, only OTP confirmation
    return result;
  }

  /**
   * Verify signup with OTP - Step 2: Complete registration
   * This verifies the OTP and creates the user account
   */
  async verifySignUp(options: { email: string; code: string }): Promise<ApiResult<AuthSession>> {
    const result = await this.client.requestPublic<AuthSession>(`${this.basePath}/verify-signup`, {
      method: 'POST',
      body: {
        email: options.email,
        code: options.code,
      },
    });

    if (result.data) {
      this.session = result.data;
    }

    return result;
  }

  /**
   * Sign in with email and password.
   *
   * If the account has a verified MFA factor, the response data is an
   * {@link MfaChallenge} (not a session) — call {@link verifyMfa} with the
   * `challenge_token` and a TOTP code to finish. Use {@link isMfaChallenge} to
   * branch.
   */
  async signIn(credentials: SignInCredentials): Promise<ApiResult<AuthSession | MfaChallenge>> {
    const result = await this.client.requestPublic<AuthSession | MfaChallenge>(`${this.basePath}/signin`, {
      method: 'POST',
      body: {
        email: credentials.email,
        password: credentials.password,
      },
    });

    // Only persist a real session — an MFA challenge isn't one yet.
    if (result.data && !isMfaChallenge(result.data)) {
      this.session = result.data as AuthSession;
    }

    return result;
  }

  /** Complete an MFA-gated sign-in with the challenge token and a TOTP code. */
  async verifyMfa(challengeToken: string, code: string): Promise<ApiResult<AuthSession>> {
    const result = await this.client.requestPublic<AuthSession>(`${this.basePath}/verify-mfa`, {
      method: 'POST',
      body: { challenge_token: challengeToken, code },
    });
    if (result.data) {
      this.session = result.data;
    }
    return result;
  }

  // ─── SMS OTP (phone sign-in; the project must have Twilio configured) ──

  /**
   * Send a one-time code to a phone number (E.164, e.g. `+15555550123`).
   * Rate limited per phone: a 429 error has code `SMS_RATE_LIMITED`.
   */
  async signInWithSms(phone: string): Promise<ApiResult<{ success: boolean; message: string; expires_in: number }>> {
    return this.client.requestPublic(`${this.basePath}/sms/send-otp`, { method: 'POST', body: { phone } });
  }

  /**
   * Verify a phone OTP and sign in (creates the user on first sign-in).
   * After 5 wrong codes a 429 error has code `OTP_RATE_LIMITED`.
   */
  async verifySmsOtp(phone: string, code: string): Promise<ApiResult<AuthSession>> {
    const result = await this.client.requestPublic<AuthSession>(`${this.basePath}/sms/verify-otp`, {
      method: 'POST',
      body: { phone, code },
    });
    if (result.data) {
      this.session = result.data;
    }
    return result;
  }

  /**
   * Sign out the current user
   */
  async signOut(): Promise<ApiResult<{ success: boolean }>> {
    const token = await this.getAccessToken();
    const result: ApiResult<{ success: boolean }> = token
      ? await this.client.requestWithToken<{ success: boolean }>(`${this.basePath}/signout`, token, { method: 'POST' })
      : { data: { success: true }, error: null };

    this.session = null;
    return result;
  }

  /**
   * Refresh the current session
   */
  async refreshSession(): Promise<ApiResult<AuthSession>> {
    const refreshToken = this.session?.refresh_token;
    if (!refreshToken) {
      return {
        data: null,
        error: { message: 'No refresh token available', code: 'NO_SESSION' },
      };
    }

    // Refresh tokens rotate: concurrent callers share one request instead of
    // replaying the same (then revoked) token.
    this.refreshing ??= this.client
      .requestPublic<AuthSession>(`${this.basePath}/refresh`, {
        method: 'POST',
        body: { refresh_token: refreshToken },
      })
      .then((result) => {
        if (result.data) this.session = result.data;
        // Rejected refresh token: the session is dead, so stop reporting it.
        else if (result.error.status === 401) this.session = null;
        return result;
      })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /**
   * Send password recovery email
   */
  async resetPasswordForEmail(options: PasswordRecoveryOptions): Promise<ApiResult<{ success: boolean }>> {
    return this.client.requestPublic<{ success: boolean }>(`${this.basePath}/recover-password`, {
      method: 'POST',
      body: { email: options.email },
    });
  }

  /**
   * Reset password with the OTP from the recovery email.
   *
   * The API body is `{ email, code, new_password }` — we keep the SDK
   * surface (`token`, `password`) readable and map to the server names.
   */
  async updatePassword(options: PasswordResetOptions): Promise<ApiResult<{ success: boolean }>> {
    return this.client.requestPublic<{ success: boolean }>(`${this.basePath}/reset-password`, {
      method: 'POST',
      body: {
        email: options.email,
        code: options.token,
        new_password: options.password,
      },
    });
  }

  /**
   * Get current user profile
   */
  async getProfile(): Promise<ApiResult<AuthUser>> {
    return this.withToken((token) => this.client.requestWithToken<AuthUser>(`${this.basePath}/user`, token));
  }

  /**
   * Update the signed-in user. `metadata` is merged into `user_metadata`.
   * Changing `email` or `password` requires `current_password` (accounts
   * without a password need a sign-in under 10 minutes old instead); otherwise
   * the API answers 401 with code `REAUTH_REQUIRED`. A new `email` is not
   * applied yet: a code is sent to it and the returned user carries
   * `new_email` until {@link verifyEmailChange} succeeds.
   */
  async updateUser(options: UpdateUserOptions): Promise<ApiResult<AuthUser>> {
    const { metadata, ...rest } = options;
    const result = await this.withToken((token) =>
      this.client.requestWithToken<{ user: AuthUser }>(`${this.basePath}/user`, token, {
        method: 'PUT',
        body: metadata === undefined ? rest : { ...rest, data: metadata },
      }),
    );
    if (result.error) return result;

    const user = result.data.user;
    if (this.session && user) this.session = { ...this.session, user };
    return { data: user, error: null };
  }

  /**
   * Confirm a pending email change with the code sent to the new address.
   * The access token keeps the old `email` claim until the next refresh.
   */
  async verifyEmailChange(code: string): Promise<ApiResult<AuthUser>> {
    const result = await this.withToken((token) =>
      this.client.requestWithToken<{ user: AuthUser }>(`${this.basePath}/user/email/verify`, token, {
        method: 'POST',
        body: { code },
      }),
    );
    if (result.error) return result;
    const user = result.data.user;
    if (this.session && user) this.session = { ...this.session, user };
    return { data: user, error: null };
  }

  /**
   * Delete current user account
   */
  async deleteUser(): Promise<ApiResult<{ success: boolean }>> {
    const result = await this.withToken((token) =>
      this.client.requestWithToken<{ success: boolean }>(`${this.basePath}/user`, token, { method: 'DELETE' }),
    );

    if (result.data) {
      this.session = null;
    }

    return result;
  }

  /**
   * Set session manually (e.g., from stored tokens)
   */
  setSession(session: AuthSession): void {
    this.session = session;
  }

  // ─── Passkey / WebAuthn ───────────────────────────────────────────────
  // Runtime-agnostic — consumers drive `navigator.credentials.*` themselves
  // (e.g. via @simplewebauthn/browser) and pass the result to the verify
  // methods below.

  async registerPasskeyOptions(
    opts: { device_name?: string } = {},
  ): Promise<ApiResult<PasskeyRegistrationOptions>> {
    return this.withToken((token) => this.client.requestWithToken<PasskeyRegistrationOptions>(
      `${this.basePath}/passkey/register/options`,
      token,
      { method: 'POST', body: { device_name: opts.device_name } },
    ));
  }

  async registerPasskeyVerify(
    input: PasskeyRegisterVerifyOptions,
  ): Promise<ApiResult<PasskeyDevice>> {
    return this.withToken((token) => this.client.requestWithToken<PasskeyDevice>(
      `${this.basePath}/passkey/register/verify`,
      token,
      { method: 'POST', body: input },
    ));
  }

  /**
   * Begin a passkey sign-up ceremony. Creates a passwordless user record
   * server-side and returns attestation options. If an account already
   * exists with the supplied email the server responds with 409 — route
   * the user to sign-in (then `registerPasskeyOptions` to add a passkey).
   */
  async signUpWithPasskeyOptions(
    opts: PasskeySignUpOptions,
  ): Promise<ApiResult<PasskeyRegistrationOptions>> {
    return this.client.requestPublic<PasskeyRegistrationOptions>(
      `${this.basePath}/passkey/signup/options`,
      { method: 'POST', body: opts },
    );
  }

  /**
   * Complete a passkey sign-up ceremony. On success the SDK stores the
   * freshly issued session so subsequent calls act as the new user.
   */
  async signUpWithPasskeyVerify(
    input: PasskeySignUpVerifyOptions,
  ): Promise<ApiResult<AuthSession>> {
    const result = await this.client.requestPublic<AuthSession>(
      `${this.basePath}/passkey/signup/verify`,
      { method: 'POST', body: input },
    );
    if (result.data) {
      this.session = result.data;
    }
    return result;
  }

  async signInWithPasskeyOptions(
    opts: { identifier?: string } = {},
  ): Promise<ApiResult<PasskeyAuthenticationOptions>> {
    return this.client.requestPublic<PasskeyAuthenticationOptions>(
      `${this.basePath}/passkey/login/options`,
      { method: 'POST', body: opts.identifier ? { identifier: opts.identifier } : {} },
    );
  }

  async signInWithPasskeyVerify(
    input: PasskeyAuthenticateVerifyOptions,
  ): Promise<ApiResult<AuthSession>> {
    const result = await this.client.requestPublic<AuthSession>(
      `${this.basePath}/passkey/login/verify`,
      { method: 'POST', body: input },
    );
    if (result.data) {
      this.session = result.data;
    }
    return result;
  }

  async listPasskeys(): Promise<ApiResult<PasskeyDevice[]>> {
    return this.withToken((token) => this.client.requestWithToken<PasskeyDevice[]>(
      `${this.basePath}/passkey/devices`,
      token,
    ));
  }

  async renamePasskey(id: string, deviceName: string): Promise<ApiResult<PasskeyDevice>> {
    return this.withToken((token) => this.client.requestWithToken<PasskeyDevice>(
      `${this.basePath}/passkey/devices/${encodeURIComponent(id)}`,
      token,
      { method: 'PATCH', body: { device_name: deviceName } },
    ));
  }

  async revokePasskey(id: string): Promise<ApiResult<{ success: boolean }>> {
    return this.withToken((token) => this.client.requestWithToken<{ success: boolean }>(
      `${this.basePath}/passkey/devices/${encodeURIComponent(id)}`,
      token,
      { method: 'DELETE' },
    ));
  }

  // ─── MFA (TOTP / authenticator apps) ──────────────────────────────────

  /** Begin TOTP enrollment. `code` (TOTP or recovery code) is required when a verified factor already exists. */
  async enrollMfaTotp(
    friendlyName?: string,
    code?: string,
  ): Promise<ApiResult<{ factor_id: string; secret: string; otpauth_url: string; qr_code: string }>> {
    return this.withToken((token) => this.client.requestWithToken<{ factor_id: string; secret: string; otpauth_url: string; qr_code: string }>(
      `${this.basePath}/mfa/totp/enroll`,
      token,
      { method: 'POST', body: { friendly_name: friendlyName, code } },
    ));
  }

  /** Confirm enrollment with the first code. On success returns the user's
   *  single-use `recovery_codes` (shown once — store them safely). */
  async verifyMfaEnrollment(
    factorId: string,
    code: string,
  ): Promise<ApiResult<{ success: boolean; recovery_codes: string[] }>> {
    return this.withToken((token) => this.client.requestWithToken<{ success: boolean; recovery_codes: string[] }>(
      `${this.basePath}/mfa/totp/verify`,
      token,
      { method: 'POST', body: { factor_id: factorId, code } },
    ));
  }

  /** Regenerate the user's MFA recovery codes — returns the new set once.
   *  `code` (TOTP or recovery code) is required while a verified factor exists. */
  async regenerateMfaRecoveryCodes(code?: string): Promise<ApiResult<{ codes: string[] }>> {
    return this.withToken((token) => this.client.requestWithToken<{ codes: string[] }>(
      `${this.basePath}/mfa/recovery-codes`,
      token,
      { method: 'POST', body: { code } },
    ));
  }

  async listMfaFactors(): Promise<ApiResult<MfaFactor[]>> {
    return this.withToken((token) => this.client.requestWithToken<MfaFactor[]>(
      `${this.basePath}/mfa/factors`,
      token,
    ));
  }

  /** Remove an MFA factor. `code` (TOTP or recovery code) is required while a verified factor exists. */
  async unenrollMfa(factorId: string, code?: string): Promise<ApiResult<{ success: boolean }>> {
    return this.withToken((token) => this.client.requestWithToken<{ success: boolean }>(
      `${this.basePath}/mfa/factors/${encodeURIComponent(factorId)}`,
      token,
      { method: 'DELETE', body: { code } },
    ));
  }
}

/** Stamp `expires_at` (unix seconds) from `expires_in` so expiry survives a reload. */
function withExpiry(session: AuthSession | null): AuthSession | null {
  if (!session || session.expires_at || !session.expires_in) return session;
  return { ...session, expires_at: Math.floor(Date.now() / 1000) + session.expires_in };
}
