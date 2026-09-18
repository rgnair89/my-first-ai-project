// supabase/functions/ingest-mumbai-schools/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { withAdminAuth } from "../_shared/auth.ts";

const MUMBAI_ZONES = [
  { name: 'Bandra West Mumbai', latitude: 19.0657, longitude: 72.8383 },
  { name: 'Andheri West Mumbai', latitude: 19.1136, longitude: 72.8335 },
  { name: 'Parel Sewri Mumbai', latitude: 19.0033, longitude: 72.8424 },       // Covers JBCN Parel area
  { name: 'Mulund West Mumbai', latitude: 19.1726, longitude: 72.9562 },      // Covers JBCN Mulund area
  { name: 'Chembur Mumbai', latitude: 19.0625, longitude: 72.9023 },           // Covers JBCN Chembur
  { name: 'Oshiwara Andheri Mumbai', latitude: 19.1450, longitude: 72.8340 },  // Covers JBCN Oshiwara
  { name: 'Borivali West Mumbai', latitude: 19.2307, longitude: 72.8567 },     // Covers JBCN Borivali
  { name: 'Thane West', latitude: 19.2183, longitude: 72.9781 }
];

// Helper to determine board affiliation from school name and address
function detectBoard(name: string, address: string): string {
  const text = `${name} ${address}`.toLowerCase();
  const boards: string[] = [];

  if (text.includes('ib') || text.includes('international baccalaureate') || text.includes('world school')) {
    boards.push('IB');
  }
  if (text.includes('igcse') || text.includes('cambridge')) {
    boards.push('IGCSE');
  }
  if (text.includes('icse') || text.includes('convent') || text.includes('scottish') || text.includes('cathedral')) {
    boards.push('ICSE');
  }
  if (text.includes('cbse') || text.includes('public school') || text.includes('bhavan') || text.includes('d.a.v.') || text.includes('dav')) {
    boards.push('CBSE');
  }

  if (boards.length > 0) {
    return boards.join(' / ');
  }
  if (text.includes('high school') || text.includes('vidyalaya') || text.includes('vidyamandir')) {
    return 'State Board';
  }
  return 'CBSE / ICSE';
}

// Helper to generate a realistic initial fee structure based on the board
function getEstimatedFeesByBoard(board: string) {
  if (board.includes('IB') || board.includes('IGCSE')) {
    return {
      base_tuition_annual: 420000,
      transport_annual: 55000,
      admission_one_time: 75000,
      tech_activity_annual: 30000,
      cafeteria_annual: 25000,
      total_tco: 605000
    };
  }
  if (board.includes('ICSE')) {
    return {
      base_tuition_annual: 165000,
      transport_annual: 32000,
      admission_one_time: 25000,
      tech_activity_annual: 15000,
      cafeteria_annual: 0,
      total_tco: 237000
    };
  }
  if (board.includes('CBSE')) {
    return {
      base_tuition_annual: 125000,
      transport_annual: 28000,
      admission_one_time: 25000,
      tech_activity_annual: 12000,
      cafeteria_annual: 0,
      total_tco: 190000
    };
  }
  return {
    base_tuition_annual: 65000,
    transport_annual: 22000,
    admission_one_time: 15000,
    tech_activity_annual: 8000,
    cafeteria_annual: 0,
    total_tco: 110000
  };
}

serve(withAdminAuth(async (_req) => {
  try {
    const googleApiKey = Deno.env.get('GOOGLE_MAPS_API_KEY') || '';
    if (!googleApiKey) {
      return new Response(JSON.stringify({ error: "GOOGLE_MAPS_API_KEY secret is missing in Supabase." }), { status: 400 });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    let totalAdded = 0;
    const debugLogs: string[] = [];

    for (const zone of MUMBAI_ZONES) {
      // Fetch places with websiteUri included in the field mask
      const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': googleApiKey,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri'
        },
        body: JSON.stringify({
          textQuery: `schools in ${zone.name}`,
          locationBias: {
            circle: {
              center: { latitude: zone.latitude, longitude: zone.longitude },
              radius: 5000.0
            }
          }
        })
      });

      const data = await response.json();

      if (data.error) {
        return new Response(JSON.stringify({ 
          success: false, 
          google_error: data.error.message, 
          status: data.error.status 
        }), { status: 400 });
      }

      if (data.places && data.places.length > 0) {
        for (const place of data.places) {
          const name = place.displayName?.text;
          const address = place.formattedAddress || zone.name;
          const lat = place.location?.latitude;
          const lon = place.location?.longitude;
          const rating = place.rating || 4.2;
          const reviewCount = place.userRatingCount || 45;
          const website = place.websiteUri || null;

          if (!name || !lat || !lon) continue;

          // Check if school already exists by name AND proximity (handles multiple franchise campuses)
          const { data: existing } = await supabaseAdmin
            .from('schools')
            .select('id, latitude, longitude, website')
            .eq('name', name);

          let isDuplicate = false;
          let existingCampusId: string | null = null;

          if (existing && existing.length > 0) {
            for (const s of existing) {
              const latDiff = Math.abs(s.latitude - lat);
              const lonDiff = Math.abs(s.longitude - lon);
              
              // True duplicate if within ~2km
              if (latDiff < 0.02 && lonDiff < 0.02) {
                isDuplicate = true;
                existingCampusId = s.id;
                // Backfill website if the record was previously missing it
                if (!s.website && website) {
                  await supabaseAdmin.from('schools').update({ website }).eq('id', s.id);
                }
                break;
              }
            }
          }

          if (!isDuplicate) {
            const detectedBoard = detectBoard(name, address);
            const feeTier = getEstimatedFeesByBoard(detectedBoard);

            const { data: newSchool, error: insertError } = await supabaseAdmin
              .from('schools')
              .insert([{
                name,
                address,
                website,
                board: detectedBoard,
                established_year: 1998,
                latitude: lat,
                longitude: lon,
                google_rating: rating,
                google_review_count: reviewCount,
                admissions_open: true,
                student_teacher_ratio: detectedBoard.includes('IB') ? '10:1' : '15:1'
              }])
              .select()
              .single();

            if (newSchool) {
              await supabaseAdmin.from('school_fees').insert([{
                school_id: newSchool.id,
                ...feeTier
              }]);
              totalAdded++;
            } else if (insertError) {
              debugLogs.push(`Insert failed for ${name}: ${insertError.message}`);
            }
          }
        }
      } else {
        debugLogs.push(`No places returned by Google for zone: ${zone.name}`);
      }

      // Small pacing pause between zone requests
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return new Response(JSON.stringify({ 
      success: true, 
      total_new_schools_added: totalAdded, 
      logs: debugLogs 
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}));