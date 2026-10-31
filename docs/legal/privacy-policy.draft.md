# StudentLLM Cloud - Privacy Policy (draft)

> **DRAFT, not legal advice, to be reviewed by a qualified lawyer before use.**
>
> This draft has not been reviewed by a lawyer. It is not in force and must not be published as it stands. Every `[PLACEHOLDER: ...]` marker must be completed or removed and every `[LAWYER: ...]` note resolved, in particular the legal bases, the retention periods, the international transfer mechanisms, and whether a data protection impact assessment or a DPO is needed. Section 3 is derived from the data table in [docs/cloud-plan.md](../cloud-plan.md#data-flow-and-what-is-stored); if the two differ, fix them together. It must also stay consistent with [SECURITY.md](../../SECURITY.md) and the [terms of service draft](./terms-of-service.draft.md).

Version: [PLACEHOLDER: version number]
Effective date: [PLACEHOLDER: date]

## 1. Scope

This policy describes how personal data is processed when you use the optional StudentLLM Cloud service (the "Service"). It covers account sign-in, the Plus plan, cloud models, and cloud transcription and OCR. Encrypted backup and sync is planned for a later release and is not part of the Service at launch; this policy will be updated and your consent asked again before it is introduced.

It does not cover the local StudentLLM application. In local mode the application makes no implicit network request, keeps your course data on your device, and does not send it to us. Using the application with your own provider key is a direct relationship between you and that provider, which has its own policy.

The Service is off by default. The application makes no request to the Service unless you sign in, open the cloud panel, or trigger a cloud action, and it sends course content only after you have seen the consent screen and agreed to the providers and features listed on it.

## 2. Controller

The controller is [PLACEHOLDER: company legal name and legal form], registered [PLACEHOLDER: country and register, to be confirmed by the lawyer] under number [PLACEHOLDER: registration number], registered office [PLACEHOLDER: address] ("we").

Contact for privacy matters: [PLACEHOLDER: privacy contact email and postal address].

Data protection officer: [PLACEHOLDER: name and contact of the DPO, or a statement that no DPO has been designated and why; to be decided with the lawyer]. EU representative: [PLACEHOLDER: not applicable if the controller is established in the EU; LAWYER: confirm].

## 3. Data we process

### 3.1 What we hold

This is the complete list of what the Service stores about you.

| Data | Details | Purpose |
| --- | --- | --- |
| Account | An internal account identifier (random, meaningless outside the Service); your sign-in email address, converted to lower case and **stored in clear** because we must send email to it; whether it is verified; your Google account subject identifier if you link Google; account status; creation, last sign-in and last request times | Run your account |
| Pending sign-in records | A hash of the sign-in state, a PKCE challenge, the type of redirect, a hash of the one-time email code, attempt and resend counters, times. Deleted when used or after 10 minutes | Complete one sign-in |
| Sign-in counters | Failed-attempt and request counters keyed by a salted hash of your email address and of your connection address. **We do not store IP addresses.** The salt rotates and the entries expire after 24 hours | Limit brute force and abuse |
| Sessions and devices | A session identifier, a hash of your current refresh token, a device identifier, a device label (by default the platform name, which you can edit), creation, last use and revocation times | Keep you signed in, let you revoke a device |
| Consent records | Which provider set and which features you agreed to, the version of the consent text, whether you granted or withdrew, and the time | Prove and enforce your consent |
| Plan | Your plan, status and period, the anchor date of your usage window, whether it cancels at the end of the period, and the customer and subscription identifiers assigned by Paddle | Know what you are entitled to |
| Payment event records | Paddle event identifier, type, time, and a short list of non-sensitive fields (ids, status, period, price identifier). Events we cannot match to an account are kept in quarantine without creating an account | Process payments reliably and without duplicates |
| Usage | Credits used and reserved per usage window and per feature, request counts, and a short ledger of settled requests (request identifier, feature, model name, credits, time) kept 24 hours for idempotency and then folded into totals | Enforce your budget and show your usage meter |
| Operational logs | A request identifier, your account identifier, the route, a status code, credits charged, latency and time. No content, no tokens, no IP address | Operate and debug the Service |

We do not receive or store your card number or billing address (Paddle does, see section 5). We do not store geolocation. We do not use advertising or analytics identifiers.

### 3.2 What we do not store

We do not store the content you send: not your questions, not the course passages, transcripts, documents, audio or images, and not the answers. We do not store request or response bodies, access tokens, plaintext refresh tokens or one-time codes.

### 3.3 Content in transit

When you use a cloud feature, the content needed to produce the result is processed: your question and the course passages used as context, the transcript or document text to be formatted, audio for transcription, or an image for text recognition. It passes through our gateway to the inference provider and back to you, and exists only in memory for the duration of the request. **We do not store it, we do not log it, and we do not use it to train models.** The inference provider receives it to generate the result; its role and retention are in section 5.

When we call an inference provider we include a pseudonymous per-account identifier (a keyed hash of your account identifier) in the request so that the provider can limit abuse without learning who you are. It is not your email address or account identifier.

### 3.4 Technical data at the network edge

Our hosting and network provider necessarily process IP addresses and connection metadata to deliver your requests and to protect its network. We do not store IP addresses ourselves and do not receive them in our logs; the provider's own retention applies (see section 5).

### 3.5 Communications

If you contact us we process your message and email address to answer.

### 3.6 Automated processing

We do not sell personal data. We do not show advertising. We use no profiling for marketing. Rate limits, budget enforcement and abuse detection are applied automatically using your usage counters, the number of devices and session patterns (not your location). They do not produce legal or similarly significant effects on you; if your account is limited or suspended you can contact us for a human review.

### 3.7 Cookies

The application does not use cookies. If our website does, they are described in [PLACEHOLDER: cookie notice].

## 4. Purposes and legal bases

| Purpose | Legal basis (GDPR art. 6) |
| --- | --- |
| Create and secure your account; sign you in | Performance of the contract (art. 6(1)(b)) |
| Process the content you ask the Service to process (content in transit) | Performance of the contract (art. 6(1)(b)). The explicit consent screen in the application is a **separate, stricter safeguard** that we add: we send nothing to the cloud without it, you give it per feature and per provider set, and you can withdraw it at any time, which stops cloud processing immediately. [LAWYER: decide whether consent (art. 6(1)(a)) should additionally or instead be the legal basis, and how withdrawal and the contract interact] |
| Manage your plan, payments and refunds | Performance of the contract (art. 6(1)(b)) |
| Enforce your budget and rate limits | Performance of the contract (art. 6(1)(b)) and legitimate interests (art. 6(1)(f)) |
| Security, fraud and abuse prevention, service integrity | Legitimate interests (art. 6(1)(f)): protecting the Service and its users [LAWYER: legitimate interest assessment] |
| Accounting and legal obligations | Legal obligation (art. 6(1)(c)) |
| Answer requests and exercise of rights | Legitimate interests (art. 6(1)(f)) and legal obligation (art. 6(1)(c)) |
| Record your consent choices | Legal obligation (art. 6(1)(c)) and legitimate interests (art. 6(1)(f)): proof of consent |

You are not required by law to provide the data, but without it we cannot provide the Service.

## 5. Recipients and processors

We use the following processors and independent providers. [PLACEHOLDER: confirm each, with legal entity, location of processing and the data processing agreement in place, before publication. The consent screen names the providers of the provider set you agree to.]

| Recipient | Role | What it receives | Notes |
| --- | --- | --- | --- |
| Inference provider: [PLACEHOLDER: provider legal name and processing region; the first planned production model is gpt-oss-120b on Groq, to be confirmed] | Processor | Content in transit (prompts and passages, transcript text), the pseudonymous per-account identifier | Must contract that it does not train on the content and keeps it no longer than needed to provide the response; retention [PLACEHOLDER: provider retention terms]. We route only to the providers in the set you consented to |
| Transcription and OCR provider(s): [PLACEHOLDER: provider(s), chosen before launch] | Processor | Audio or images in transit | Same conditions; listed in the provider set shown on the consent screen |
| Paddle ([PLACEHOLDER: Paddle legal entity]) | Merchant of record and **seller of record** of your purchase; controller for the sale, payment, tax and invoice data | Your purchase details, email, and billing data you give at checkout | Paddle's privacy notice applies to the checkout and refunds. We receive the plan status, identifiers and events |
| Google ([PLACEHOLDER: Google legal entity]) | Identity provider when you choose Sign in with Google | Your sign-in with Google | Google's privacy policy applies to your Google account. We request only `openid` and `email`, no offline access, use the data only to sign you in, discard Google's tokens after verifying them, and follow the Google API Services User Data Policy including its limited-use rules [PLACEHOLDER: OAuth client configuration and verification status; LAWYER: confirm] |
| Hosting and edge provider: [PLACEHOLDER: hosting provider, for example Cloudflare; location] | Processor | All traffic to the gateway, the account database and counters | It sees IP addresses and connection metadata and, because it terminates the connection, the request in transit. It does not store the content under our configuration. Its own retention for network metadata: [PLACEHOLDER: provider retention] |
| Email delivery provider: [PLACEHOLDER: provider] | Processor | Your email address and the message with your one-time code | |
| Monitoring and alerting provider: [PLACEHOLDER: provider, if any] | Processor | Operational metrics and logs without content | Only if used; configured not to receive content |
| Support tool: [PLACEHOLDER: provider, if any] | Processor | The messages you send us | Only if used |
| Professionals (accountants, lawyers, auditors) and authorities | Recipients as required | As needed | Under confidentiality or legal obligation |

We do not sell data and do not share it with other third parties. We will update this list before adding a processor and tell you, and ask for consent again where the processing of your content changes. Backup storage providers will be added before the backup option is introduced.

## 6. Transfers outside the European Economic Area

Some of our providers or their sub-processors are or may be located outside the EEA, in particular in the United States. [PLACEHOLDER: list the actual locations.] Where a transfer takes place, we rely on one of the following mechanisms, depending on the provider: an adequacy decision (for example the EU-US Data Privacy Framework for certified providers), or the standard contractual clauses approved by the European Commission with supplementary measures where needed. [LAWYER: complete after the provider contracts are known and a transfer impact assessment is done.] A copy of the safeguards can be requested from [PLACEHOLDER: privacy contact]. Where possible we prefer processing in the EEA. [PLACEHOLDER: processing region of each provider.]

## 7. Retention

Periods are proposals to confirm. [LAWYER: confirm each.]

| Data | Retention |
| --- | --- |
| Content in transit | Not stored by us; held in memory for the duration of the request. The provider retains it only as stated in its contract with us ([PLACEHOLDER: provider retention]) |
| Prompts and answers | Not stored |
| Account | While your account is open; deleted within [PLACEHOLDER: period, for example 30 days] of closure |
| Pending sign-in records | Deleted on use or after 10 minutes |
| Sign-in counters | 24 hours |
| Sessions and devices | Until they expire or are revoked, then deleted within [PLACEHOLDER: period] |
| Consent records | Duration of the account plus [PLACEHOLDER: period] as proof |
| Plan | While your account is open; transaction references for [PLACEHOLDER: period] after the sale, according to accounting obligations |
| Payment event records | [PLACEHOLDER: period, for example 90 days] |
| Usage ledger and totals | Ledger 24 hours; totals [PLACEHOLDER: period, for example the current and previous 12 months] |
| Operational logs | [PLACEHOLDER: period, for example 30 days] |
| Support messages | [PLACEHOLDER: period] after the request is closed |
| Platform snapshots and backups | Our database platform may keep point-in-time snapshots; deleted data can persist in them for up to [PLACEHOLDER: platform retention period, to verify with the provider] before it is overwritten, and is not restored except to recover from an incident |

## 8. Security

We apply measures appropriate to the risk, including: encrypted connections; no content in logs; short-lived access tokens and rotating, revocable refresh tokens kept in your operating system's credential store; one-time codes stored only as keyed hashes; secrets kept only in server secret stores; fixed upstream endpoints; per-account limits; minimal data collection; restricted access to our systems; and incident handling. In case of a personal data breach likely to create a risk, we will notify the competent authority within 72 hours and tell you where required. Report a vulnerability as described in [SECURITY.md](../../SECURITY.md).

## 9. Your rights

You have the right to: access the personal data we hold about you; have it rectified; have it erased; restrict processing; object to processing based on legitimate interests; receive the data you provided in a portable format; withdraw consent at any time without affecting earlier processing; and give instructions about the fate of your data after your death (French law) [LAWYER: confirm].

How to exercise them:

- **Access and portability:** the account screen offers an export of everything the Service holds (section 3.1) in a machine-readable file. You can also contact [PLACEHOLDER: privacy contact].
- **Erasure and closure:** you can delete your account from the account screen; it cancels your subscription and deletes the data in section 3.1, subject to the retention periods above.
- **Withdrawal of consent:** turn the cloud feature or the whole cloud mode off in the application; it takes effect at the next request.
- **Content:** the Service does not hold your content, so there is nothing to access, correct or export on our side. Your course data stays on your device. When encrypted backup is introduced, you will be able to download it and decrypt it on your device, and delete it.
- Other requests, and objection: write to [PLACEHOLDER: privacy contact]. We reply within one month, extendable under the law, and may ask you to verify your identity.

You can complain to the data protection authority of your country of residence or of the place of the alleged infringement. [PLACEHOLDER/LAWYER: for a controller established in France, the supervisory authority is the CNIL; confirm the competent authority and the lead-authority position before publishing.]

## 10. Children and students

The Service is intended for students. [LAWYER: in France a minor under 15 cannot consent alone to processing of personal data for an online service; set the minimum age, the process for users under it, and for minors aged 15 to 17 regarding contract capacity.] [PLACEHOLDER: age rule.]

## 11. Third-party content

Your recordings and documents may contain personal data of other people (lecturers, classmates). You are responsible for having the right to process them and for respecting your institution's rules. We process such content only in transit and do not store it.

## 12. AI transparency

Answers, notes, transcriptions and study material produced with a cloud model are generated by AI systems operated by our providers. The application labels generated content and shows whether it came from a cloud or a local model. [LAWYER: confirm the transparency obligations that apply to us under the EU AI Act (art. 50) and their dates, and whether we are a provider or a deployer of the systems.]

## 13. Data protection impact assessment

[LAWYER: decide whether a DPIA is required given the volume of student data and the use of AI models, and document the decision.]

## 14. Changes to this policy

We will publish changes with a new version and effective date and inform you in the application or by email before a material change applies. If a change adds a new data category sent to the cloud, a new provider or provider set, or a new purpose, the application asks for your consent again before applying it.

## 15. Contact

- Controller: [PLACEHOLDER: company name, address]
- Privacy contact: [PLACEHOLDER: email]
- DPO: [PLACEHOLDER: name and contact, or not designated]
