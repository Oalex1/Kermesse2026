import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const urlValida =
  typeof SUPABASE_URL === "string" &&
  /^https?:\/\/.+/i.test(SUPABASE_URL);

const keyValida =
  typeof SUPABASE_ANON_KEY === "string" &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.startsWith("__");

export const isConfigured = urlValida && keyValida;

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;