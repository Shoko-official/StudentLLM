# StudentLLM Cloud - Terms of Service (draft)

> **DRAFT, not legal advice, to be reviewed by a qualified lawyer before use.**
>
> This draft has not been reviewed by a lawyer. It is not in force and must not be published or presented to users as it stands. Every `[PLACEHOLDER: ...]` marker must be completed or removed, and every `[LAWYER: ...]` note must be resolved. Consumer-law points (withdrawal, renewal, mediation, minors, liability) are especially sensitive. It must stay consistent with [docs/cloud-plan.md](../cloud-plan.md) and with the [privacy policy draft](./privacy-policy.draft.md).

Version: [PLACEHOLDER: version number]
Effective date: [PLACEHOLDER: date]

## 1. Who we are

The StudentLLM Cloud service (the "Service") is operated by [PLACEHOLDER: company legal name and legal form], a company incorporated in France, registered with the [PLACEHOLDER: trade and companies register, for example RCS city] under number [PLACEHOLDER: registration number], with its registered office at [PLACEHOLDER: registered address], share capital [PLACEHOLDER: amount, if applicable], VAT number [PLACEHOLDER: VAT number, if applicable] ("we", "us").

Publication director: [PLACEHOLDER: name]. Contact: [PLACEHOLDER: contact email and postal address]. Hosting provider of the Service: [PLACEHOLDER: hosting provider name, address, and country].

## 2. What these terms cover, and what they do not

2.1 The Service is an optional paid cloud offering that works with the StudentLLM application: larger cloud models, a monthly usage budget, cloud transcription and OCR, and encrypted backup and sync (the "Plus" plan).

2.2 The StudentLLM application itself is free and open-source software published under the MIT License. These terms do not change that license, do not restrict your rights under it, and do not apply to your use of the application in its local mode. The local application keeps working without the Service, without an account, and without any payment. No feature of the local application is removed or limited because you do not subscribe.

2.3 You can also use the application with your own provider key. That use is between you and that provider and is not part of the Service.

2.4 The Service is off by default. Nothing is sent to the Service unless you create an account, accept these terms, and turn on a cloud feature (see section 6).

## 3. Account

3.1 You sign in with Google (OpenID Connect) or with a single-use link sent to your email address. We do not store passwords.

3.2 You must provide an email address you control, keep access to your sign-in method secure, and tell us promptly if you suspect unauthorized use. You are responsible for activity under your account.

3.3 One account is for one person. Plus may be used on a limited number of devices [PLACEHOLDER: number of devices]. You may not share your account or resell access.

3.4 Minimum age: [LAWYER: in France a minor under 15 cannot consent alone to the processing of their personal data for an information society service (Loi Informatique et Libertes, art. 45); decide the minimum age, the process for minors, and the effect on contract capacity]. You confirm that you meet the minimum age of [PLACEHOLDER: age], or have the consent of a parent or legal guardian.

3.5 You may close your account at any time from the account screen or by contacting us. See section 12.

## 4. Plans, prices and payment

4.1 **Plus.** [PLACEHOLDER: confirm at publication] 6 EUR per month, VAT included, or a semester pass of [PLACEHOLDER: about 25 EUR] for a fixed period of 5 months. A student discount may be offered under conditions published at [PLACEHOLDER: URL]. The price shown at checkout, including taxes, is the price you pay. We may change prices for future periods with at least [PLACEHOLDER: notice period] notice; a change does not apply to a period you have already paid for. There are no advertisements and no overage charges: if your monthly budget is used up you are never billed more.

4.2 **Merchant of record.** Payments are processed by Paddle, which acts as the seller (merchant of record) for the Service, collects the payment, applies VAT and issues the invoice. Your purchase is therefore also subject to Paddle's buyer terms and privacy notice, available at checkout. [LAWYER: confirm how the sale is characterized between us, Paddle and the consumer, and which entity is the seller for consumer-law information duties.] We do not receive or store your card number.

4.3 **Monthly subscription.** The monthly plan renews automatically every month until you cancel. You can cancel at any time from your account (through the Paddle customer portal). Cancellation takes effect at the end of the period you have paid for; the Service remains available until then. [LAWYER: check renewal reminder and cancellation-by-the-same-means requirements for tacit renewal.]

4.4 **Semester pass.** The semester pass is a single payment for 5 months of Plus. [PLACEHOLDER: it does not renew automatically; confirm before publication.]

4.5 **Failed payment.** If a payment fails, Paddle may retry. If it is not recovered within [PLACEHOLDER: period], Plus ends and your account becomes a free account.

4.6 **Refunds.** See section 5 for the right of withdrawal. Beyond legal rights, [PLACEHOLDER: refund policy, if any].

## 5. Right of withdrawal (consumers)

5.1 If you are a consumer in the European Union, you have a right to withdraw from a distance contract within 14 days of conclusion without giving a reason (Code de la consommation, art. L221-18 and following). [LAWYER: confirm the wording and the model withdrawal form.]

5.2 The Service starts immediately after payment. At checkout you will be asked to request that the Service start before the end of the withdrawal period and to acknowledge that, once the Service has been fully performed, you lose the right of withdrawal, and that if you withdraw after performance has started you pay a proportionate amount for what has been used (art. L221-25 and L221-28). [LAWYER: confirm how the express request and acknowledgement are collected, and whether Paddle's checkout handles it for the sale.]

5.3 To withdraw, contact us at [PLACEHOLDER: contact] or use Paddle's refund process. Where Paddle is the seller, refunds are issued by Paddle.

## 6. Cloud features, consent and what is sent

6.1 Cloud features are optional. Before the first cloud request, and for each feature, the application shows a consent screen that describes what will be sent, to whom, and what we keep. You can preview what will be sent, turn each feature off at any time, and mark a course as never sent to the cloud.

6.2 When you use a cloud feature, the content needed to produce the answer (for example your question and the passages of your course sources used as context, the text of a transcript to format, audio for transcription, or an image for text recognition) is sent through our gateway to an inference provider that processes it to generate the result and returns it to you.

6.3 We do not store this content, your prompts or the answers. The Service keeps only your account identifier, your sign-in identifiers, your plan, usage counters and timestamps. Our logs do not contain your content. The details, including the list of providers that process data on our behalf, are in the [privacy policy](./privacy-policy.draft.md).

6.4 Encrypted backup and sync is a separate option. If you turn it on, your files are encrypted on your device before upload and stored in encrypted form; we cannot read them. If you lose your recovery secret, we cannot recover your backup.

6.5 Without your consent for a feature, the application does not use the Service for it. If the Service is unavailable or your budget is used up, the application falls back automatically to your local model and tells you.

## 7. Usage budget, limits and fair use

7.1 Plus includes a monthly usage budget, expressed in credits, which is shown in the application at all times. The budget resets at the start of each billing period and does not roll over. The size of the budget and the weights of features and models are published at [PLACEHOLDER: URL] and may be adjusted for future periods with notice.

7.2 We apply rate limits, concurrency limits and per-request size limits to protect the Service. They are visible in the application when reached.

7.3 When your budget is used up, cloud requests stop until the next period and the application uses your local model. You are not charged more.

7.4 We may route requests to different models or providers, and change them, to maintain quality, availability and cost. Availability of a given model is not guaranteed.

## 8. Acceptable use

You will not: use the Service unlawfully; infringe others' rights; upload content you have no right to use, including recordings made in breach of a person's rights or a school's rules; attempt to bypass the budget, rate limits or authentication; share, resell or pool accounts to increase limits; attempt to reach the upstream providers or our systems other than through the application; probe, scrape, disrupt or overload the Service; extract or reverse engineer the Service's non-public interfaces; use the Service to generate content that is illegal or that the underlying providers prohibit; or use the Service to build a competing model or service. Provider usage policies that apply to the models are [PLACEHOLDER: list or link].

You are responsible for complying with the rules of your school or university, including its rules on recording lectures and on the use of AI tools. The Service does not authorize you to do anything those rules forbid.

## 9. Your content and intellectual property

9.1 You keep all rights in your recordings, documents, notes and other content ("Your Content"). We do not claim any ownership.

9.2 You grant us a limited, temporary, non-exclusive license to process Your Content only as needed to provide the cloud features you use, and to transmit it to the inference providers for that purpose. We do not use Your Content to train models. [LAWYER: confirm. Also confirm that each provider contract prevents training on your content.]

9.3 You are responsible for having the right to process Your Content, including lecturers' and fellow students' rights and the rights in course material.

9.4 The Service's trademarks, name, logo and non-public components are ours or our licensors'. The open-source application is licensed to you under the MIT License.

## 10. Accuracy of generated results

AI-generated answers, notes and study material can be wrong, incomplete or out of date. The application links results to sources so that you can verify them, but you remain responsible for checking them before relying on them, in particular for exams, assessments, citations or any decision with consequences. The Service does not provide professional, medical, legal or financial advice.

## 11. Availability and changes to the Service

11.1 We aim to keep the Service available but do not promise uninterrupted operation. [PLACEHOLDER: any uptime commitment, if any.] The local application is not affected by an outage.

11.2 We may update, suspend or discontinue features or providers. If we discontinue the Plus plan, we will give at least [PLACEHOLDER: notice period] notice and refund the unused part of any prepaid period, and your local application and data remain usable. [LAWYER: confirm.]

11.3 We may change these terms. We will inform you by [PLACEHOLDER: means] at least [PLACEHOLDER: notice period] before the change takes effect. If you do not accept the change you may close your account; refund of the unused prepaid part [PLACEHOLDER: policy]. Changes that add a new category of data sent to the cloud or a new provider need your consent again before they apply to you.

## 12. Suspension, termination and deletion

12.1 You can stop using the Service and close your account at any time. When you close your account we delete your account data and any encrypted backup as described in the privacy policy, except what we must keep by law.

12.2 We may suspend or terminate your account, with notice where possible, if you materially breach these terms, abuse the Service, create a security risk, or if required by law or a provider. In urgent cases we may suspend first and explain after. If we terminate without fault on your side, we refund the unused prepaid part of the period.

12.3 Your local application and your local data are never affected by termination.

## 13. Liability

13.1 Nothing in these terms excludes or limits liability that cannot be excluded or limited by law, including for death or personal injury, fraud, gross negligence or willful misconduct, and the mandatory rights of consumers, including the legal guarantees of conformity for digital content and digital services (Code de la consommation, art. L224-25-1 and following). [LAWYER: verify article references.]

13.2 Subject to that, we are liable only for foreseeable direct damage resulting from our breach, and our total liability for a given 12-month period is limited to the amounts you paid for the Service in that period, to the extent permitted by law. [LAWYER: review for consumers and for any business users.] We are not liable for indirect damages, loss of data stored only locally, loss of grades, results or opportunities, or for the content generated by AI models, to the extent permitted by law.

13.3 The Service depends on third-party providers. We are not liable for their failures beyond what the law requires, but we remain responsible toward you for the Service.

## 14. Personal data

Our processing of personal data is described in the [privacy policy](./privacy-policy.draft.md). You can exercise your rights as described there, including by contacting [PLACEHOLDER: privacy contact].

## 15. Complaints, mediation and governing law

15.1 Contact us first at [PLACEHOLDER: contact]. We will answer within [PLACEHOLDER: period].

15.2 Consumer mediation: if a dispute is not resolved, a consumer may use, free of charge, a consumer mediator: [PLACEHOLDER: name and contact details of the consumer mediator the company has joined, as required by Code de la consommation, art. L612-1 and following]. [LAWYER: confirm obligation and wording.]

15.3 These terms are governed by French law. If you are a consumer residing in the European Union, you also benefit from the mandatory consumer protection provisions of the law of your country of residence, and you may bring proceedings before the courts of France or of your country of residence.

15.4 For a user who is not a consumer, the courts of [PLACEHOLDER: city, for example the seat of the company] have jurisdiction, subject to mandatory rules. [LAWYER: confirm.]

## 16. General

These terms, with the privacy policy and the checkout information, are the whole agreement for the Service. If a clause is invalid the rest remains in force. A failure to enforce a right is not a waiver. You may not transfer your account. We may transfer the Service to a successor with notice to you. These terms are written in English; [PLACEHOLDER: French version, which a French consumer may expect to be available and to prevail; to be decided with the lawyer].

## Legal notice placeholders (to complete)

- Company: [PLACEHOLDER: name, legal form, capital]
- Register and number: [PLACEHOLDER: register and registration number]
- VAT number: [PLACEHOLDER: VAT number]
- Registered office: [PLACEHOLDER: address]
- Publication director: [PLACEHOLDER: name]
- Contact: [PLACEHOLDER: email and phone, if required]
- Hosting provider: [PLACEHOLDER: name, address, country]
- Consumer mediator: [PLACEHOLDER: mediator]
