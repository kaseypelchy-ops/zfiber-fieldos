# Automatic Customer Sale Confirmation

FieldOS can automatically email a customer after a sale is successfully inserted into `public.sales_orders`.

## Configured mail identity

- SMTP server: `imap.zitomedia.com`
- Port: `587`
- Security: STARTTLS
- SMTP username: `zitod2dfiber@zitomedia.com`
- From: `Zito Media <zitod2dfiber@zitomedia.com>`
- Reply-to: `zitod2dfiber@zitomedia.com`

The SMTP password is not stored in this repository.

## 1. Run the database migration

In Supabase, open **SQL Editor**, paste the contents of:

`supabase/migrations/20260804_sale_customer_confirmation.sql`

Select **Run**. Existing sales are marked `not_applicable`; only sales inserted after deployment default to `pending`.

## 2. Add Vercel environment variables

Open the FieldOS project in Vercel and go to **Settings → Environment Variables**. Add these variables for Production, Preview, and Development as appropriate:

| Variable | Value |
|---|---|
| `SMTP_HOST` | `imap.zitomedia.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USERNAME` | `zitod2dfiber@zitomedia.com` |
| `SMTP_PASSWORD` | Enter the SMTP password directly in Vercel |
| `SMTP_FROM_EMAIL` | `zitod2dfiber@zitomedia.com` |
| `SMTP_FROM_NAME` | `Zito Media` |
| `SMTP_REPLY_TO` | `zitod2dfiber@zitomedia.com` |
| `SUPABASE_URL` | The FieldOS Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | The FieldOS service-role/secret key |
| `SALE_EMAIL_WEBHOOK_SECRET` | A new long random secret used only for this webhook |

Never put `SMTP_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY`, or `SALE_EMAIL_WEBHOOK_SECRET` in `app.js`, HTML, GitHub, or a Supabase table.

After saving the variables, redeploy the project so the function receives them.

## 3. Create the Supabase Database Webhook

In Supabase, open **Database → Webhooks** and create a webhook with:

- Name: `fieldos-sale-customer-confirmation`
- Table: `public.sales_orders`
- Event: `INSERT` only
- Method: `POST`
- URL: `https://YOUR-FIELDOS-DOMAIN/api/send-sale-confirmation`
- HTTP header: `x-fieldos-webhook-secret`
- Header value: exactly the same random value used for `SALE_EMAIL_WEBHOOK_SECRET`

Do not enable UPDATE or DELETE events.

## 4. Test safely

Use an email address you control for the first test sale.

After submitting it, run:

```sql
select
  id,
  customer_name,
  email,
  customer_confirmation_status,
  customer_confirmation_sent_at,
  customer_confirmation_message_id,
  customer_confirmation_error
from public.sales_orders
order by created_at desc
limit 10;
```

Expected status: `sent`.

Other statuses:

- `skipped`: email was blank or invalid.
- `failed`: SMTP rejected the connection or message; inspect the recorded error and Vercel function log.
- `sending`: the function reserved the sale. If it remains here, inspect Vercel logs before manually retrying so the customer is not emailed twice.
- `pending`: the webhook has not processed the sale yet.

## Safety behavior

- The endpoint accepts only authenticated `INSERT` webhooks for `sales_orders`.
- It reserves a `pending` sale before contacting SMTP.
- Duplicate webhook deliveries return `already_processed` without sending again.
- Offline FieldOS sales are emailed only after they synchronize and create the database record.
- Historical sales are not emailed.
