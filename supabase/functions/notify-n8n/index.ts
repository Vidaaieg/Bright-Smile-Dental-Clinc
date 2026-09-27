/* ==========================================================================
   Edge Function: notify-n8n   (OUTBOUND — DentalClinic → n8n)

   Forwards events to an n8n workflow so you can automate what happens after a
   booking: WhatsApp confirmations, reminders the day before, adding the
   appointment to a calendar, alerting reception.

   Two ways to trigger it:

   A) Database Webhook (recommended — fires automatically)
      Supabase Dashboard → Database → Webhooks → Create:
        Table:      appointments      (repeat for payments)
        Events:     Insert, Update
        Type:       Supabase Edge Function → notify-n8n

   B) Called directly from another Edge Function or a server.

   Deploy:  supabase functions deploy notify-n8n
   Secrets: supabase secrets set N8N_WEBHOOK_URL="https://your-n8n/webhook/dental"
            supabase secrets set N8N_SHARED_SECRET="a-long-random-string"

   n8n verifies the X-DentalClinic-Signature header (HMAC-SHA256 of the raw
   body, hex) using the same shared secret. Without that check, anyone who
   learns the n8n URL could post fake appointments into your workflow.
   ========================================================================== */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

async function sign(body: string, secret: string): Promise<string> {
   const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
   );

   const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));

   return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
}

Deno.serve(async (req) => {
   try {
      const webhookUrl = Deno.env.get('N8N_WEBHOOK_URL');
      const sharedSecret = Deno.env.get('N8N_SHARED_SECRET');

      if (!webhookUrl || !sharedSecret) {
         console.error('N8N_WEBHOOK_URL or N8N_SHARED_SECRET is not set');
         return new Response('Not configured', { status: 500 });
      }

      const incoming = await req.json();

      // Database Webhooks send { type, table, record, old_record }.
      const table: string = incoming.table ?? incoming.event_table ?? 'unknown';
      const operation: string = incoming.type ?? 'MANUAL';
      const record = incoming.record ?? incoming;

      /* Enrich with the service name so the n8n workflow does not have to
         query the database again to build a readable message. */
      let serviceName: string | null = null;

      if (record?.service_slug) {
         const admin = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
         );

         const { data } = await admin
            .from('services')
            .select('name_en')
            .eq('slug', record.service_slug)
            .single();

         serviceName = data?.name_en ?? null;
      }

      /* Send only what an automation needs. Nothing here is a card number,
         a password, or a full medical record. */
      const payload = JSON.stringify({
         event: `${table}.${operation.toLowerCase()}`,
         sent_at: new Date().toISOString(),
         data: {
            id: record?.id ?? null,
            table,
            status: record?.status ?? null,
            service_slug: record?.service_slug ?? null,
            service_name: serviceName,
            scheduled_at: record?.scheduled_at ?? null,
            patient_name: record?.patient_name ?? null,
            patient_email: record?.patient_email ?? null,
            patient_phone: record?.patient_phone ?? null,
            amount_piastres: record?.amount_piastres ?? null,
            currency: record?.currency ?? null
         }
      });

      const response = await fetch(webhookUrl, {
         method: 'POST',
         headers: {
            'Content-Type': 'application/json',
            'X-DentalClinic-Signature': await sign(payload, sharedSecret),
            'X-DentalClinic-Event': `${table}.${operation.toLowerCase()}`
         },
         body: payload
      });

      if (!response.ok) {
         console.error('n8n rejected the event:', response.status, await response.text());
         return new Response('n8n rejected the event', { status: 502 });
      }

      return new Response('OK', { status: 200 });
   } catch (error) {
      console.error('notify-n8n failed:', error);
      return new Response('Error', { status: 500 });
   }
});
