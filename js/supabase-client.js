/* ==========================================================================
   Bright Smile Clinic — Supabase connection

   HOW TO CONFIGURE
   1. Create a project at https://supabase.com
   2. Dashboard → Project Settings → API
   3. Copy "Project URL" and the "anon public" key into the two lines below.

   The anon key is MEANT to be public — it is safe in this file. It only ever
   grants what the Row Level Security policies in supabase/schema.sql allow.

   NEVER put the `service_role` key in this file, or in any file the browser
   downloads. It bypasses every security policy. It belongs only in Edge
   Function secrets.
   ========================================================================== */

window.DENTAL_CONFIG = {
   SUPABASE_URL: 'https://suzxvaoblbwgqsjtukkq.supabase.co',
   SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1enh2YW9ibGJ3Z3FzanR1a2txIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMjkzMzAsImV4cCI6MjEwMTYwNTMzMH0.hVlrlpmqdAP9PC8oD1zo16qtIlvfzjlyxW5CKmM05Ag'
};

(function () {
   'use strict';

   /* Pages live at three depths (/, /pages/, /services/), so scripts that
      redirect need to know how to get back to the site root. */
   window.DENTAL_BASE = /\/(pages|services)\//.test(window.location.pathname) ? '../' : '';

   var config = window.DENTAL_CONFIG;

   var isConfigured = config.SUPABASE_URL.indexOf('YOUR_') !== 0 &&
                      config.SUPABASE_ANON_KEY.indexOf('YOUR_') !== 0;

   window.DentalDB = {
      configured: isConfigured,
      client: null
   };

   if (!isConfigured) {
      console.warn(
         'Bright Smile Clinic: Supabase is not configured yet. ' +
         'Add your project URL and anon key in js/supabase-client.js — see SETUP.md.'
      );
      return;
   }

   if (!window.supabase || !window.supabase.createClient) {
      console.error('Bright Smile Clinic: the Supabase library failed to load.');
      return;
   }

   window.DentalDB.client = window.supabase.createClient(
      config.SUPABASE_URL,
      config.SUPABASE_ANON_KEY
   );
}());
