/* ==========================================================================
   Edge Function: clinic-api   (INBOUND — n8n → DentalClinic)

   Lets an n8n workflow read and update clinic data. Protected by an API key,
   not by a patient login, because n8n is a machine and has no session.

   Deploy:  supabase functions deploy clinic-api --no-verify-jwt
   Secret:  supabase secrets set CLINIC_API_KEY="$(openssl rand -hex 32)"

   In n8n, send the key as a header:
      X-API-Key: <the value you generated>

   Endpoints (all POST, JSON body { action, ... }):
      { "action": "list_appointments", "from": "...", "to": "...", "status": "paid" }
      { "action": "get_appointment", "id": "uuid" }
      { "action": "cancel_appointment", "id": "uuid" }
      { "action": "tomorrow_reminders" }        ← for the reminder workflow

   SECURITY NOTES
     * This function uses service_role, so it bypasses Row Level Security.
       That is why the API key check happens FIRST and refuses everything
       else. Treat that key like a password to the whole database.
     * It is deliberately an allow-list of actions, not a generic query
       endpoint. n8n cannot ask it for arbitrary SQL.
     * It never returns payment card data — there is none to return.
     * Rotate the key by setting a new secret and updating n8n.
   ========================================================================== */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function json(body: unknown, status = 200) {
   return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
   });
}

/* Constant-time comparison so the key cannot be guessed character by
   character from response timing. */
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
   if (req.method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405);
   }

   /* --- API key check, before anything else -------------------------- */

   const expectedKey = Deno.env.get('CLINIC_API_KEY');

   if (!expectedKey || expectedKey.length < 32) {
      console.error('CLINIC_API_KEY is missing or too short');
      return json({ error: 'Not configured.' }, 500);
   }

   const providedKey = req.headers.get('X-API-Key') ?? '';

   if (!safeEqual(providedKey, expectedKey)) {
      // Deliberately vague, and logged so you can see attempts.
      console.warn('clinic-api: rejected a request with a bad API key');
      return json({ error: 'Unauthorised.' }, 401);
   }

   try {
      const admin = createClient(
         Deno.env.get('SUPABASE_URL')!,
         Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      );

      const body = await req.json();
      const action = String(body.action ?? '');

      const SELECT =
         'id, scheduled_at, status, patient_name, patient_email, patient_phone, ' +
         'service_slug, created_at, services(name_en, name_ar, price_piastres)';

      switch (action) {
         case 'list_appointments': {
            let query = admin
               .from('appointments')
               .select(SELECT)
               .order('scheduled_at', { ascending: true })
               .limit(Math.min(Number(body.limit) || 100, 500));

            if (body.from) { query = query.gte('scheduled_at', body.from); }
            if (body.to) { query = query.lte('scheduled_at', body.to); }
            if (body.status) { query = query.eq('status', String(body.status)); }

            const { data, error } = await query;

            if (error) { return json({ error: error.message }, 400); }

            return json({ appointments: data });
         }

         case 'get_appointment': {
            const { data, error } = await admin
               .from('appointments')
               .select(SELECT)
               .eq('id', String(body.id ?? ''))
               .single();

            if (error) { return json({ error: 'Not found.' }, 404); }

            return json({ appointment: data });
         }

         case 'cancel_appointment': {
            const { data, error } = await admin
               .from('appointments')
               .update({ status: 'cancelled' })
               .eq('id', String(body.id ?? ''))
               .select('id, status')
               .single();

            if (error) { return json({ error: error.message }, 400); }

            return json({ appointment: data });
         }

         /* Everything booked for tomorrow — drive the reminder workflow. */
         case 'tomorrow_reminders': {
            const start = new Date();
            start.setDate(start.getDate() + 1);
            start.setHours(0, 0, 0, 0);

            const end = new Date(start);
            end.setDate(end.getDate() + 1);

            const { data, error } = await admin
               .from('appointments')
               .select(SELECT)
               .eq('status', 'paid')
               .gte('scheduled_at', start.toISOString())
               .lt('scheduled_at', end.toISOString())
               .order('scheduled_at', { ascending: true });

            if (error) { return json({ error: error.message }, 400); }

            return json({ date: start.toISOString().slice(0, 10), appointments: data });
         }

         default:
            return json({ error: 'Unknown action.' }, 400);
      }
   } catch (error) {
      console.error('clinic-api failed:', error);
      return json({ error: 'Unexpected error.' }, 500);
   }
});
