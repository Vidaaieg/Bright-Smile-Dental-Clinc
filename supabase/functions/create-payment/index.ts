/* ==========================================================================
   Edge Function: create-payment

   Runs on Supabase's servers, NOT in the browser. This is the only place the
   Paymob API key exists.

   What it guarantees:
     * The caller is signed in (their JWT is verified).
     * The appointment belongs to that caller.
     * The amount comes from the `services` table, never from the request
       body — so a patient cannot pay 1 EGP for an implant by editing the page.

   Deploy:  supabase functions deploy create-payment
   Secrets: supabase secrets set PAYMOB_API_KEY=... \
                                 PAYMOB_CARD_INTEGRATION_ID=... \
                                 PAYMOB_IFRAME_ID=...

   NOTE: Paymob has more than one generation of API. This uses the classic
   three-step flow (auth token → order → payment key). Check the current
   Paymob dashboard docs before going live, and adjust the endpoints if your
   account is provisioned for the newer Intention API.
   ========================================================================== */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PAYMOB_BASE = 'https://accept.paymob.com/api';

/* LAYER 4 — only our own site may call this function.
   Set with: supabase secrets set ALLOWED_ORIGINS="https://dentalclinic.com,http://localhost:3000" */
function allowedOrigins(): string[] {
   return (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:3000')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
}

function corsFor(req: Request): Record<string, string> {
   const origin = req.headers.get('Origin') ?? '';
   const permitted = allowedOrigins().includes(origin);

   return {
      // Echo the origin only when it is on the list. Never '*'.
      'Access-Control-Allow-Origin': permitted ? origin : 'null',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin'
   };
}

function json(body: unknown, status: number, req: Request) {
   return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsFor(req), 'Content-Type': 'application/json' }
   });
}

Deno.serve(async (req) => {
   if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsFor(req) });
   }

   if (req.method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405, req);
   }

   const origin = req.headers.get('Origin') ?? '';

   if (origin && !allowedOrigins().includes(origin)) {
      return json({ error: 'Origin not allowed.' }, 403, req);
   }

   try {
      const apiKey = Deno.env.get('PAYMOB_API_KEY');
      const integrationId = Deno.env.get('PAYMOB_CARD_INTEGRATION_ID');
      const iframeId = Deno.env.get('PAYMOB_IFRAME_ID');

      if (!apiKey || !integrationId || !iframeId) {
         return json({ error: 'Paymob secrets are not set on this project.' }, 500, req);
      }

      /* --- 1. Who is calling? ------------------------------------------- */

      const authHeader = req.headers.get('Authorization') ?? '';

      const userClient = createClient(
         Deno.env.get('SUPABASE_URL')!,
         Deno.env.get('SUPABASE_ANON_KEY')!,
         { global: { headers: { Authorization: authHeader } } }
      );

      const { data: userData, error: userError } = await userClient.auth.getUser();

      if (userError || !userData.user) {
         return json({ error: 'You must be signed in to pay.' }, 401, req);
      }

      const user = userData.user;
      const { appointment_id } = await req.json();

      if (!appointment_id) {
         return json({ error: 'Missing appointment_id.' }, 400, req);
      }

      /* --- 2. Read the appointment and its REAL price -------------------- */

      // service_role bypasses RLS, so we check ownership ourselves below.
      const admin = createClient(
         Deno.env.get('SUPABASE_URL')!,
         Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      );

      const { data: appointment, error: appointmentError } = await admin
         .from('appointments')
         .select('id, user_id, status, patient_name, patient_email, patient_phone, services(slug, name_en, price_piastres)')
         .eq('id', appointment_id)
         .single();

      if (appointmentError || !appointment) {
         return json({ error: 'Appointment not found.' }, 404, req);
      }

      if (appointment.user_id !== user.id) {
         return json({ error: 'This appointment is not yours.' }, 403, req);
      }

      if (appointment.status === 'paid') {
         return json({ error: 'This appointment is already paid.' }, 409, req);
      }

      // deno-lint-ignore no-explicit-any
      const service = appointment.services as any;
      const amountPiastres: number = service.price_piastres;

      /* --- 3. Paymob: auth token ---------------------------------------- */

      const authResponse = await fetch(`${PAYMOB_BASE}/auth/tokens`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ api_key: apiKey })
      });

      if (!authResponse.ok) {
         return json({ error: 'Could not authenticate with Paymob.' }, 502, req);
      }

      const { token } = await authResponse.json();

      /* --- 4. Paymob: register the order -------------------------------- */

      const orderResponse = await fetch(`${PAYMOB_BASE}/ecommerce/orders`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            auth_token: token,
            delivery_needed: false,
            amount_cents: amountPiastres,
            currency: 'EGP',
            merchant_order_id: `${appointment.id}-${Date.now()}`,
            items: [{
               name: service.name_en,
               amount_cents: amountPiastres,
               description: `Bright Smile Clinic — ${service.name_en}`,
               quantity: 1
            }]
         })
      });

      if (!orderResponse.ok) {
         return json({ error: 'Could not create the Paymob order.' }, 502, req);
      }

      const order = await orderResponse.json();

      /* --- 5. Paymob: payment key --------------------------------------- */

      const [firstName, ...rest] = (appointment.patient_name || 'Patient').split(' ');

      const keyResponse = await fetch(`${PAYMOB_BASE}/acceptance/payment_keys`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            auth_token: token,
            amount_cents: amountPiastres,
            expiration: 3600,
            order_id: order.id,
            currency: 'EGP',
            integration_id: Number(integrationId),
            billing_data: {
               first_name: firstName,
               last_name: rest.join(' ') || 'N/A',
               email: appointment.patient_email,
               phone_number: appointment.patient_phone,
               // Paymob rejects empty strings; "NA" is its documented filler.
               apartment: 'NA', floor: 'NA', street: 'NA', building: 'NA',
               shipping_method: 'NA', postal_code: 'NA', city: 'Hurghada',
               state: 'Red Sea', country: 'EG'
            }
         })
      });

      if (!keyResponse.ok) {
         return json({ error: 'Could not create the Paymob payment key.' }, 502, req);
      }

      const paymentKey = await keyResponse.json();

      /* --- 6. Record the pending payment -------------------------------- */

      await admin.from('payments').insert({
         appointment_id: appointment.id,
         user_id: user.id,
         amount_piastres: amountPiastres,
         currency: 'EGP',
         provider: 'paymob',
         provider_order_id: String(order.id),
         status: 'pending'
      });

      return json({
         iframe_url: `${PAYMOB_BASE}/acceptance/iframes/${iframeId}?payment_token=${paymentKey.token}`,
         amount_piastres: amountPiastres
      }, 200, req);
   } catch (error) {
      console.error('create-payment failed:', error);
      return json({ error: 'Unexpected error creating the payment.' }, 500, req);
   }
});
