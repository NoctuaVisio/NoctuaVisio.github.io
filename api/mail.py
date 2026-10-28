"""Sending mail, which the site needs for exactly one thing: the login link.

Written against **SMTP** rather than one vendor's HTTP API on purpose. SMTP is
what every option speaks — a Google Workspace mailbox, Resend, SendGrid, SES,
Postmark — so changing who delivers the mail is an environment change and never
a code change. Picking an HTTP API would have married the login flow to one
account.

Enabled by having the settings; absent, `send` refuses loudly instead of
pretending. A login link that was never delivered but reported success is worse
than a visible failure: the person waits for a message that does not exist.

    SMTP_HOST      smtp.gmail.com
    SMTP_PORT      587 (STARTTLS) or 465 (implicit TLS)
    SMTP_USER      the mailbox
    SMTP_PASSWORD  an app password, not the account password
    MAIL_FROM      what the recipient sees, defaults to SMTP_USER
"""
from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr


def _setting(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name, default)
    return value.strip() if isinstance(value, str) else value


def configured() -> bool:
    return bool(_setting("SMTP_HOST") and _setting("SMTP_USER") and _setting("SMTP_PASSWORD"))


def sender() -> str:
    return _setting("MAIL_FROM") or _setting("SMTP_USER") or ""


def send(to: str, subject: str, text: str, html: str | None = None) -> None:
    """Deliver one message, or raise.

    Raising is the contract. The caller turns it into a 503 so the page can say
    the mail could not be sent, which is true and actionable, rather than
    telling someone to check an inbox that will stay empty.
    """
    if not configured():
        raise RuntimeError("SMTP is not configured on this service")

    host = _setting("SMTP_HOST")
    port = int(_setting("SMTP_PORT", "587") or 587)
    user = _setting("SMTP_USER")
    password = _setting("SMTP_PASSWORD")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("Noctua", sender()))
    msg["To"] = to
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")

    context = ssl.create_default_context()
    # 465 is TLS from the first byte; 587 starts in the clear and upgrades.
    # Both are normal, and which one a provider wants is not ours to guess.
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=20) as server:
            server.login(user, password)
            server.send_message(msg)
        return
    with smtplib.SMTP(host, port, timeout=20) as server:
        server.starttls(context=context)
        server.login(user, password)
        server.send_message(msg)
