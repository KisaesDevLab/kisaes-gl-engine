// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import nodemailer from 'nodemailer';
import { getSmtpSettings } from './admin.service.js';

/** Escape HTML special characters to prevent XSS in email templates */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Strip CR/LF from a subject-line segment to prevent header injection. */
function safeSubjectSegment(s: string): string {
  return s.replace(/[\r\n]/g, ' ');
}

/**
 * System-level email service — uses global SMTP settings (from system_settings table or .env).
 * Used for password resets, user invites, and system notifications.
 * Separate from the per-company email service used for invoices/reminders.
 */

async function createTransport() {
  const smtp = await getSmtpSettings();

  if (!smtp.smtpHost) {
    return {
      from: smtp.smtpFrom || 'noreply@kisbooks.local',
      transport: {
        sendMail: async (opts: any) => {
          console.log(`[SYSTEM EMAIL STUB] To: ${opts.to}, Subject: ${opts.subject}`);
          return { messageId: 'stub-' + Date.now() };
        },
      },
      configured: false,
    };
  }

  return {
    from: smtp.smtpFrom,
    transport: nodemailer.createTransport({
      host: smtp.smtpHost,
      port: smtp.smtpPort,
      secure: smtp.smtpPort === 465,
      auth: smtp.smtpUser ? { user: smtp.smtpUser, pass: smtp.smtpPass } : undefined,
    }),
    configured: true,
  };
}

export async function isConfigured(): Promise<boolean> {
  const { configured } = await createTransport();
  return configured;
}

export async function sendPasswordResetEmail(email: string, resetToken: string, appUrl?: string): Promise<void> {
  const { from, transport } = await createTransport();
  const baseUrl = appUrl || process.env['CORS_ORIGIN'] || 'http://localhost:5173';
  const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

  await transport.sendMail({
    from,
    to: email,
    subject: 'Vibe MyBooks — Password Reset',
    text: `You requested a password reset for your Vibe MyBooks account.\n\nClick the link below to set a new password:\n${resetLink}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, you can safely ignore this email.`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:20px">
        <h2 style="color:#111827;margin-bottom:16px">Password Reset</h2>
        <p style="color:#374151;font-size:14px;line-height:1.5">
          You requested a password reset for your Vibe MyBooks account.
        </p>
        <a href="${resetLink}" style="display:inline-block;margin:20px 0;padding:12px 24px;background:#2563EB;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">
          Reset Password
        </a>
        <p style="color:#6B7280;font-size:12px;line-height:1.5">
          This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `,
  });
}

export async function sendInviteEmail(email: string, inviterName: string, tenantName: string, temporaryPassword: string, appUrl?: string): Promise<void> {
  const { from, transport } = await createTransport();
  const baseUrl = appUrl || process.env['CORS_ORIGIN'] || 'http://localhost:5173';
  const loginLink = `${baseUrl}/login`;

  await transport.sendMail({
    from,
    to: email,
    subject: `Vibe MyBooks — You've been invited to ${safeSubjectSegment(tenantName)}`,
    text: `${inviterName} has invited you to access "${tenantName}" on Vibe MyBooks.\n\nYour temporary login credentials:\nEmail: ${email}\nPassword: ${temporaryPassword}\n\nLog in at: ${loginLink}\n\nPlease change your password after your first login.`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:20px">
        <h2 style="color:#111827;margin-bottom:16px">You've Been Invited</h2>
        <p style="color:#374151;font-size:14px;line-height:1.5">
          ${escapeHtml(inviterName)} has invited you to access <strong>${escapeHtml(tenantName)}</strong> on Vibe MyBooks.
        </p>
        <div style="margin:20px 0;padding:16px;background:#F3F4F6;border-radius:8px">
          <p style="margin:0 0 8px;font-size:13px;color:#6B7280">Your temporary credentials:</p>
          <p style="margin:0 0 4px;font-size:14px"><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p style="margin:0;font-size:14px"><strong>Password:</strong> <code style="background:#E5E7EB;padding:2px 6px;border-radius:4px">${escapeHtml(temporaryPassword)}</code></p>
        </div>
        <a href="${loginLink}" style="display:inline-block;margin:8px 0 20px;padding:12px 24px;background:#2563EB;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">
          Log In
        </a>
        <p style="color:#6B7280;font-size:12px">
          Please change your password after your first login.
        </p>
      </div>
    `,
  });
}

export async function sendAccessGrantedEmail(email: string, tenantName: string, appUrl?: string): Promise<void> {
  const { from, transport } = await createTransport();
  const baseUrl = appUrl || process.env['CORS_ORIGIN'] || 'http://localhost:5173';

  await transport.sendMail({
    from,
    to: email,
    subject: `Vibe MyBooks — Access granted to ${safeSubjectSegment(tenantName)}`,
    text: `You've been granted access to "${tenantName}" on Vibe MyBooks.\n\nLog in with your existing credentials at: ${baseUrl}/login\n\nYou can switch to this company from the company switcher in the sidebar.`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:20px">
        <h2 style="color:#111827;margin-bottom:16px">Access Granted</h2>
        <p style="color:#374151;font-size:14px;line-height:1.5">
          You've been granted access to <strong>${escapeHtml(tenantName)}</strong> on Vibe MyBooks.
        </p>
        <p style="color:#374151;font-size:14px;line-height:1.5">
          Log in with your existing credentials. You can switch to this company from the company switcher in the sidebar.
        </p>
        <a href="${baseUrl}/login" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#2563EB;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">
          Log In
        </a>
      </div>
    `,
  });
}

/**
 * Send a plain-text email with an optional CTA button. Replaces the old
 * `sendCustomEmail(to, subject, html)` which took raw HTML and invited
 * callers to concatenate user-controlled strings into the body. Structured
 * inputs make HTML injection impossible by construction: the body text is
 * HTML-escaped before rendering, and the CTA URL must pass basic safety
 * checks (http(s)/mailto only).
 */
export async function sendActionEmail(params: {
  to: string;
  subject: string;
  bodyText: string;
  cta?: { label: string; url: string };
}): Promise<void> {
  const { from, transport } = await createTransport();
  const safeSubject = safeSubjectSegment(params.subject);
  const safeBody = escapeHtml(params.bodyText).replace(/\n/g, '<br>');

  let ctaHtml = '';
  if (params.cta) {
    // Only allow http(s) and mailto links in the CTA. Blocks javascript: /
    // data: / file:/// URLs that would otherwise render as clickable links.
    const u = params.cta.url;
    const ok = /^https?:\/\//i.test(u) || /^mailto:/i.test(u);
    if (ok) {
      ctaHtml = `<p><a href="${escapeHtml(u)}" style="display:inline-block;padding:12px 24px;background:#4F46E5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">${escapeHtml(params.cta.label)}</a></p>`;
    }
  }

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:20px"><p>${safeBody}</p>${ctaHtml}</div>`;

  await transport.sendMail({ from, to: params.to, subject: safeSubject, text: params.bodyText, html });
}

/**
 * Deprecated: prefer sendActionEmail. Kept only for call sites we haven't
 * migrated yet. Callers MUST only pass HTML they've already escaped or
 * that contains no user-controlled substrings.
 */
export async function sendCustomEmail(to: string, subject: string, html: string): Promise<void> {
  const { from, transport } = await createTransport();
  await transport.sendMail({
    from,
    to,
    subject: safeSubjectSegment(subject),
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:20px">${html}</div>`,
  });
}

export { isConfigured as isSmtpConfigured };
