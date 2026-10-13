// Envio de e-mails do painel pela conta Gmail flow@tbnegociosdigitais.com (SMTP do Gmail, porta 465 com TLS).
// Compartilhado por auth-mail (recuperação de senha) e team-admin (envio do acesso a quem entra na equipe).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   GMAIL_APP_PASSWORD  senha de app de 16 letras gerada na conta Google (obrigatório)
//   GMAIL_USER          opcional; padrão flow@tbnegociosdigitais.com
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

export const PANEL_URL = "https://gestorflowtools.shop/financeiro/";
const user = () => (Deno.env.get("GMAIL_USER") ?? "flow@tbnegociosdigitais.com").trim();
const pass = () => (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").replace(/\s+/g, "");

export const mailConfigured = () => pass().length > 0;

export async function sendMail(o: { to: string; subject: string; html: string; text: string }) {
  const client = new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: user(), password: pass() } },
  });
  try {
    await client.send({ from: `Flow <${user()}>`, to: o.to, subject: o.subject, content: o.text, html: o.html });
  } finally {
    try { await client.close(); } catch { /* conexão já fechada */ }
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function layout(title: string, intro: string, lines: string[], button: string, link: string, foot: string): string {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f2f6f4;padding:28px 12px;font-family:Segoe UI,Arial,sans-serif;color:#10231a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #d6e4dc;overflow:hidden">
<tr><td style="background:#07291a;padding:20px 28px"><span style="color:#22e37a;font-weight:800;letter-spacing:.18em;font-size:15px">FLOW</span></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 12px;font-size:20px;color:#07291a">${esc(title)}</h1>
<p style="margin:0 0 16px;font-size:14.5px;line-height:1.6">${intro}</p>
${lines.map((l) => `<p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#34503f">${l}</p>`).join("")}
<p style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;background:#08733f;color:#ffffff;text-decoration:none;font-weight:700;font-size:14.5px;padding:12px 24px;border-radius:9px">${esc(button)}</a></p>
<p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#516a5a">Se o botão não abrir, copie e cole este endereço no navegador:</p>
<p style="margin:0 0 18px;font-size:11.5px;word-break:break-all;color:#516a5a">${esc(link)}</p>
<p style="margin:0;font-size:12px;line-height:1.6;color:#516a5a;border-top:1px solid #e3ede7;padding-top:14px">${foot}</p>
</td></tr></table>
<p style="font-size:11px;color:#7b9185;margin:14px 0 0">Mensagem automática do painel Flow. Não responda este e-mail.</p>
</td></tr></table></body></html>`;
}

export function recoveryEmail(link: string) {
  return {
    subject: "Redefinição de senha — painel Flow",
    html: layout("Redefinir sua senha", "Recebemos um pedido para redefinir a senha da sua conta no painel Flow.",
      ["Clique no botão abaixo para escolher uma senha nova. O link vale por 1 hora e só pode ser usado uma vez."],
      "Redefinir minha senha", link, "Se você não pediu a redefinição, ignore este e-mail: sua senha continua a mesma."),
    text: `Redefinição de senha — painel Flow\n\nRecebemos um pedido para redefinir a senha da sua conta.\nAbra o link abaixo para escolher uma senha nova (vale por 1 hora):\n${link}\n\nSe você não pediu, ignore este e-mail.`,
  };
}

export function accessEmail(email: string, link: string) {
  return {
    subject: "Seu acesso ao painel Flow",
    html: layout("Você recebeu acesso ao painel Flow", "Uma conta foi criada para você nos painéis Financeiro, Afiliados e Equipe.",
      [`<b>Endereço:</b> <a href="${PANEL_URL}" style="color:#08733f">${PANEL_URL}</a>`, `<b>Seu login:</b> ${esc(email)}`,
       "Para entrar, primeiro defina a sua senha pelo botão abaixo (o link vale por 1 hora). Depois é só usar o login e a senha no endereço acima."],
      "Definir minha senha", link, "Se você não esperava este acesso, ignore este e-mail."),
    text: `Você recebeu acesso ao painel Flow.\n\nEndereço: ${PANEL_URL}\nSeu login: ${email}\n\nDefina a sua senha pelo link (vale por 1 hora):\n${link}\n\nSe não esperava este acesso, ignore este e-mail.`,
  };
}
