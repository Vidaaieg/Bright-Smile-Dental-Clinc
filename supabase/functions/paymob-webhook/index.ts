/* ==========================================================================
   Edge Function: paymob-webhook

   Paymob calls this after a card is charged. THIS is what marks an
   appointment paid — never the browser, because anyone can fake a browser
   request.

   Every callback is verified with an HMAC-SHA512 signature before it is
   trusted. An unsigned or wrongly signed request is rejected.

   Deploy:  supabase functions deploy paymob-webhook --no-verify-jwt
            (--no-verify-jwt is required: Paymob has no Supabase login)
   Secret:  supabase secrets set PAYMOB_HMAC_SECRET=...

   Then paste the function URL into Paymob → Developers → Payment
   Integrations → your card integration → "Transaction processed callback".

   NOTE: check the field list below against your Paymob dashboard docs before
   going live. If Paymob changes the callback payload, the HMAC will stop
   matching and every payment will be rejected — which is the safe direction
   to fail, but you will want to know why.
   ========================================================================== */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/* The exact field order Paymob concatenates for the TRANSACTION callback.
   The order matters; changing it breaks the signature. */
const HMAC_FIELDS = [
   'amount_cents', 'created_at', 'currency', 'error_occured',
   'has_parent_transaction', 'id', 'integration_id', 'is_3d_secure',
   'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment',
   'is_voided', 'order.id', 'owner', 'pending', 'source_data.pan',
   'source_data.sub_type', 'source_data.type', 'success'
];

// deno-lint-ignore no-explicit-any
function pick(object: any, path: string): string {
   const value = path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), object);
   return value === undefined || value === null ? '' : String(value);
}

async function hmacSha512(message: string, secret: string): Promise<string> {
   const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['sign']
   );

   const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));

   return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
}

/* Constant-time compare, so a attacker cannot guess the signature byte by
   byte from how long the comparison takes. */
function safeEqual(a: string, b: string): boolean {
   if (a.length !== b.length) {
      return false;
   }

   let diff = 0;

   for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
   }

   return diff === 0;
}

Deno.serve(async (req) => {
   try {
      const hmacSecret = Deno.env.get('PAYMOB_HMAC_SECRET');

      if (!hmacSecret) {
         console.error('PAYMOB_HMAC_SECRET is not set');
         return new Response('Server not configured', { status: 500 });
      }

      const url = new URL(req.url);
      const providedHmac = url.searchParams.get('hmac') ?? '';
      const payload = await req.json();
      const transaction = payload.obj ?? payload;

      /* --- verify the signature before trusting anything ----------------- */

      const concatenated = HMAC_FIELDS.map((field) => pick(transaction, field)).join('');
      const expectedHmac = await hmacSha512(concatenated, hmacSecret);

      if (!providedHmac || !safeEqual(providedHmac.toLowerCase(), expectedHmac)) {
         console.warn('Rejected a callback with a bad HMAC signature');
         return new Response('Invalid signature', { status: 401 });
      }

      /* --- the callback is genuine; record the result -------------------- */

      const orderId = String(transaction.order?.id ?? '');
      const succeeded = transaction.success === true && transaction.pending === false;

      const admin = createClient(
         Deno.env.get('SUPABASE_URL')!,
         Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      );

      const { data: payment, error: paymentError } = await admin
         .from('payments')
         .update({
            status: succeeded ? 'paid' : 'failed',
            provider_txn_id: String(transaction.id ?? ''),
            updated_at: new Date().toISOString()
         })
         .eq('provider', 'paymob')
         .eq('provider_order_id', orderId)
         .select('appointment_id, amount_piastres')
         .single();

      if (paymentError || !payment) {
         console.error('No matching payment row for Paymob order', orderId, paymentError);
         // 200 on purpose: retrying will not help, and Paymob would keep trying.
         return new Response('No matching payment', { status: 200 });
      }

      /* Guard against a tampered amount: only mark paid if what Paymob
         charged matches what we recorded when we created the order. */
      const chargedPiastres = Number(transaction.amount_cents ?? 0);

      if (succeeded && chargedPiastres !== payment.amount_piastres) {
         console.error(
            'Amount mismatch for order', orderId,
            'charged', chargedPiastres, 'expected', payment.amount_piastres
         );
         await admin.from('payments')
            .update({ status: 'failed' })
            .eq('provider_order_id', orderId);
         return new Response('Amount mismatch', { status: 200 });
      }

      if (succeeded) {
         await admin
            .from('appointments')
            .update({ status: 'paid' })
            .eq('id', payment.appointment_id);
      }

      return new Response('OK', { status: 200 });
   } catch (error) {
      console.error('paymob-webhook failed:', error);
      return new Response('Error', { status: 500 });
   }
});
