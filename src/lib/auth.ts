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

export class AuthClient {
  private _session: AuthSession | null = null;
  private readonly storage: StorageAdapter;
  private readonly storageKey: string;

  constructor(private client: HttpClient, options: { storage?: StorageAdapter } = {}) {
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
    this._session = value;
    try {
      if (value) this.storage.setItem(this.storageKey, JSON.stringify(value));
      else this.storage.removeItem(this.storageKey);
    } catch {
      /* storage is best-effort */
    }
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
    const result = await this.client.request<{ success: boolean; message: string; email: string; expires_in: number }>(`${this.basePath}/signup`, {
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
    const result = await this.client.request<AuthSession>(`${this.basePath}/verify-signup`, {
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
    const result = await this.client.request<AuthSession | MfaChallenge>(`${this.basePath}/signin`, {
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
    const result = await this.client.request<AuthSession>(`${this.basePath}/verify-mfa`, {
      method: 'POST',
      body: { challenge_token: challengeToken, code },
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
    if (!this.session) {
      return { data: { success: true }, error: null };
    }

    const result = await this.client.request<{ success: boolean }>(`${this.basePath}/signout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.session.access_token}`,
      },
    });

    this.session = null;
    return result;
  }

  /**
   * Refresh the current session
   */
  async refreshSession(): Promise<ApiResult<AuthSession>> {
    if (!this.session?.refresh_token) {
      return {
        data: null,
        error: { message: 'No refresh token available', code: 'NO_SESSION' },
      };
    }

    const result = await this.client.request<AuthSession>(`${this.basePath}/refresh`, {
      method: 'POST',
      body: { refresh_token: this.session.refresh_token },
    });

    if (result.data) {
      this.session = result.data;
    }

    return result;
  }

  /**
   * Send password recovery email
   */
  async resetPasswordForEmail(options: PasswordRecoveryOptions): Promise<ApiResult<{ success: boolean }>> {
    return this.client.request<{ success: boolean }>(`${this.basePath}/recover-password`, {
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
    return this.client.request<{ success: boolean }>(`${this.basePath}/reset-password`, {
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
    if (!this.session?.access_token) {
      return {
        data: null,
        error: { message: 'No active session', code: 'NO_SESSION' },
      };
    }

    return this.client.request<AuthUser>(`${this.basePath}/user`, {
      headers: {
        Authorization: `Bearer ${this.session.access_token}`,
      },
    });
  }

  /**
   * Update user profile
   */
  async updateUser(options: UpdateUserOptions): Promise<ApiResult<AuthUser>> {
    if (!this.session?.access_token) {
      return {
        data: null,
        error: { message: 'No active session', code: 'NO_SESSION' },
      };
    }

    return this.client.request<AuthUser>(`${this.basePath}/user`, {
      method: 'PUT',
      body: options,
      headers: {
        Authorization: `Bearer ${this.session.access_token}`,
      },
    });
  }

  /**
   * Delete current user account
   */
  async deleteUser(): Promise<ApiResult<{ success: boolean }>> {
    if (!this.session?.access_token) {
      return {
        data: null,
        error: { message: 'No active session', code: 'NO_SESSION' },
      };
    }

    const result = await this.client.request<{ success: boolean }>(`${this.basePath}/user`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.session.access_token}`,
      },
    });

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
    if (!this.session?.access_token) {
      return { data: null, error: { message: 'No active session', code: 'NO_SESSION' } };
    }
    return this.client.requestWithToken<PasskeyRegistrationOptions>(
      `${this.basePath}/passkey/register/options`,
      this.session.access_token,
      { method: 'POST', body: { device_name: opts.device_name } },
    );
  }

  async registerPasskeyVerify(
    input: PasskeyRegisterVerifyOptions,
  ): Promise<ApiResult<PasskeyDevice>> {
    if (!this.session?.access_token) {
      return { data: null, error: { message: 'No active session', code: 'NO_SESSION' } };
    }
    return this.client.requestWithToken<PasskeyDevice>(
      `${this.basePath}/passkey/register/verify`,
      this.session.access_token,
      { method: 'POST', body: input },
    );
  }

  /**
   * Begin a passkey sign-up ceremony. Creates a passwordless user record
   * server-side and returns attestation options. If an account already
   * exists with the supplied email AND has a passkey registered, the
   * server responds with 409 — callers should route to sign-in instead.
   */
  async signUpWithPasskeyOptions(
    opts: PasskeySignUpOptions,
  ): Promise<ApiResult<PasskeyRegistrationOptions>> {
    return this.client.request<PasskeyRegistrationOptions>(
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
    const result = await this.client.request<AuthSession>(
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
    return this.client.request<PasskeyAuthenticationOptions>(
      `${this.basePath}/passkey/login/options`,
      { method: 'POST', body: opts.identifier ? { identifier: opts.identifier } : {} },
    );
  }

  async signInWithPasskeyVerify(
    input: PasskeyAuthenticateVerifyOptions,
  ): Promise<ApiResult<AuthSession>> {
    const result = await this.client.request<AuthSession>(
      `${this.basePath}/passkey/login/verify`,
      { method: 'POST', body: input },
    );
    if (result.data) {
      this.session = result.data;
    }
    return result;
  }

  async listPasskeys(): Promise<ApiResult<PasskeyDevice[]>> {
    if (!this.session?.access_token) {
      return { data: null, error: { message: 'No active session', code: 'NO_SESSION' } };
    }
    return this.client.requestWithToken<PasskeyDevice[]>(
      `${this.basePath}/passkey/devices`,
      this.session.access_token,
    );
  }

  async renamePasskey(id: string, deviceName: string): Promise<ApiResult<PasskeyDevice>> {
    if (!this.session?.access_token) {
      return { data: null, error: { message: 'No active session', code: 'NO_SESSION' } };
    }
    return this.client.requestWithToken<PasskeyDevice>(
      `${this.basePath}/passkey/devices/${encodeURIComponent(id)}`,
      this.session.access_token,
      { method: 'PATCH', body: { device_name: deviceName } },
    );
  }

  async revokePasskey(id: string): Promise<ApiResult<{ success: boolean }>> {
    if (!this.session?.access_token) {
      return { data: null, error: { message: 'No active session', code: 'NO_SESSION' } };
    }
    return this.client.requestWithToken<{ success: boolean }>(
      `${this.basePath}/passkey/devices/${encodeURIComponent(id)}`,
      this.session.access_token,
      { method: 'DELETE' },
    );
  }

  // ─── MFA (TOTP / authenticator apps) ──────────────────────────────────

  async enrollMfaTotp(
    friendlyName?: string,
  ): Promise<ApiResult<{ factor_id: string; secret: string; otpauth_url: string; qr_code: string }>> {
    if (!this.session?.access_token) {
      return { data: null, error: { message: 'No active session', code: 'NO_SESSION' } };
    }
    return this.client.requestWithToken(
      `${this.basePath}/mfa/totp/enroll`,
      this.session.access_token,
      { method: 'POST', body: { friendly_name: friendlyName } },
    );
  }

  async verifyMfaEnrollment(factorId: string, code: string): Promise<ApiResult<{ success: boolean }>> {
    if (!this.session?.access_token) {
      return { data: null, error: { message: 'No active session', code: 'NO_SESSION' } };
    }
    return this.client.requestWithToken<{ success: boolean }>(
      `${this.basePath}/mfa/totp/verify`,
      this.session.access_token,
      { method: 'POST', body: { factor_id: factorId, code } },
    );
  }

  async listMfaFactors(): Promise<ApiResult<MfaFactor[]>> {
    if (!this.session?.access_token) {
      return { data: null, error: { message: 'No active session', code: 'NO_SESSION' } };
    }
    return this.client.requestWithToken<MfaFactor[]>(
      `${this.basePath}/mfa/factors`,
      this.session.access_token,
    );
  }

  async unenrollMfa(factorId: string): Promise<ApiResult<{ success: boolean }>> {
    if (!this.session?.access_token) {
      return { data: null, error: { message: 'No active session', code: 'NO_SESSION' } };
    }
    return this.client.requestWithToken<{ success: boolean }>(
      `${this.basePath}/mfa/factors/${encodeURIComponent(factorId)}`,
      this.session.access_token,
      { method: 'DELETE' },
    );
  }
}
