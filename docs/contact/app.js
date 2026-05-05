"use strict";

const KEY = window.WEB3FORMS_KEY || "";
const form = document.getElementById("contact-form");
const submitBtn = document.getElementById("submit");
const statusEl = document.getElementById("status");

function showStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.classList.remove("hide", "ok", "err");
  statusEl.classList.add(kind);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Honeypot trap: if the hidden 'website' field is filled, silently succeed
  // (don't tell the bot it failed).
  if (form.elements["website"].value) {
    showStatus("Thanks, message sent.", "ok");
    form.reset();
    return;
  }

  if (!KEY || KEY.startsWith("PASTE-")) {
    showStatus(
      "Contact form is not configured yet. Please try again later.",
      "err",
    );
    return;
  }

  const name = form.elements["name"].value.trim();
  const email = form.elements["email"].value.trim();
  const message = form.elements["message"].value.trim();
  if (!name) {
    showStatus("Please enter your name.", "err");
    form.elements["name"].focus();
    return;
  }
  if (!email) {
    showStatus("Please enter your email.", "err");
    form.elements["email"].focus();
    return;
  }
  if (!message) {
    showStatus("Please write a message.", "err");
    form.elements["message"].focus();
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = "Sending\u2026";
  showStatus("", "");

  // FormData / urlencoded avoids the CORS preflight that Web3Forms blocks
  // when content-type is application/json. Their docs actually recommend
  // standard form encoding.
  const body = new FormData();
  body.append("access_key", KEY);
  body.append("name", name);
  body.append("email", email);
  body.append("message", message);
  body.append("from_name", "ohanaclubs.com");
  body.append("subject", form.elements["subject"].value || "ohanaclubs feedback");

  try {
    const r = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { accept: "application/json" },
      body,
    });
    const result = await r.json();
    if (r.ok && result.success) {
      showStatus("Thanks! Your message is on its way.", "ok");
      form.reset();
      if (window.gtag) {
        window.gtag("event", "contact_form_submit", { event_category: "engagement" });
      }
    } else {
      throw new Error(result.message || ("HTTP " + r.status));
    }
  } catch (err) {
    showStatus(
      "Something went wrong: " + err.message + ". Please try again later.",
      "err",
    );
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});
