// api/subscribe.js - Vercel Serverless Function for Klaviyo + Quo Integration
// FIXED: Better phone handling, subscription flow, and added Quo transactional SMS

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, firstName, lastName, phone, causeName, causeLocation, causeWhy } = req.body;

  // Validate required fields
  if (!email || !firstName || !lastName) {
    return res.status(400).json({ error: 'Missing required fields (email, firstName, lastName)' });
  }

  // Configuration from environment variables
  const KLAVIYO_PRIVATE_KEY = process.env.KLAVIYO_PRIVATE_KEY;
  const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID || 'SWfNg6';
  const KLAVIYO_REVISION = '2025-04-15';
  
  // Quo (OpenPhone) configuration
  const QUO_API_KEY = process.env.QUO_API_KEY;
  const QUO_PHONE_NUMBER_ID = process.env.QUO_PHONE_NUMBER_ID; // Your Quo phone number ID
  const QUO_FROM_NUMBER = process.env.QUO_FROM_NUMBER; // Your Quo phone number in E.164

  // Check Klaviyo configuration
  if (!KLAVIYO_PRIVATE_KEY) {
    console.error('KLAVIYO_PRIVATE_KEY environment variable is not set!');
    return res.status(500).json({ 
      error: 'Server configuration error', 
      details: 'Klaviyo API key not configured.' 
    });
  }

  const cleanEmail = email.toLowerCase().trim();

  // Format phone if provided (E.164 format: +15551234567)
  let formattedPhone = null;
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) {
      formattedPhone = '+1' + digits;
    } else if (digits.length === 11 && digits.startsWith('1')) {
      formattedPhone = '+' + digits;
    }
    console.log('Phone input:', phone, '-> Formatted:', formattedPhone);
  }

  const results = {
    klaviyo: { profile: null, subscribed: false, error: null },
    quo: { sent: false, error: null }
  };

  try {
    // =====================
    // STEP 1: KLAVIYO - Create/Update Profile
    // =====================
    const profilePayload = {
      data: {
        type: 'profile',
        attributes: {
          email: cleanEmail,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          properties: {
            'Cause Name': causeName || 'Choose for me',
            'Cause Location': causeLocation || '',
            'Cause Why': causeWhy || '',
            'Source': 'Cause Nomination Form',
            'signup_date': new Date().toISOString()
          }
        }
      }
    };

    // Add phone to profile if provided
    if (formattedPhone) {
      profilePayload.data.attributes.phone_number = formattedPhone;
    }

    console.log('=== KLAVIYO PROFILE CREATE ===');
    console.log('Email:', cleanEmail);
    console.log('Phone:', formattedPhone || 'none');

    const profileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_PRIVATE_KEY}`,
        'Content-Type': 'application/vnd.api+json',  // Use JSON:API content type
        'revision': KLAVIYO_REVISION
      },
      body: JSON.stringify(profilePayload)
    });

    let profileId = null;
    const profileText = await profileResponse.text();
    console.log('Profile response status:', profileResponse.status);

    if (profileResponse.status === 201) {
      const profileData = JSON.parse(profileText);
      profileId = profileData.data?.id;
      console.log('New profile created:', profileId);
    } else if (profileResponse.status === 409) {
      // Profile exists - get ID and update with phone/properties
      const profileData = JSON.parse(profileText);
      profileId = profileData.errors?.[0]?.meta?.duplicate_profile_id;
      console.log('Existing profile found:', profileId);
      
      if (profileId) {
        // PATCH to update existing profile with phone and new properties
        // Note: Klaviyo PATCH requires application/vnd.api+json content type
        const updatePayload = {
          data: {
            type: 'profile',
            id: profileId,
            attributes: {
              first_name: firstName.trim(),
              last_name: lastName.trim(),
              properties: {
                'Cause Name': causeName || 'Choose for me',
                'Cause Location': causeLocation || '',
                'Cause Why': causeWhy || '',
                'Source': 'Cause Nomination Form',
                'last_nomination_date': new Date().toISOString()
              }
            }
          }
        };
        
        // Important: Add phone to existing profile
        if (formattedPhone) {
          updatePayload.data.attributes.phone_number = formattedPhone;
        }
        
        console.log('PATCH payload:', JSON.stringify(updatePayload, null, 2));
        
        const updateResponse = await fetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Klaviyo-API-Key ${KLAVIYO_PRIVATE_KEY}`,
            'Content-Type': 'application/vnd.api+json',  // FIXED: Must be vnd.api+json for PATCH
            'revision': KLAVIYO_REVISION
          },
          body: JSON.stringify(updatePayload)
        });
        
        const updateText = await updateResponse.text();
        console.log('Profile update status:', updateResponse.status);
        if (updateResponse.status !== 200) {
          console.error('Profile update error:', updateText);
        }
      }
    } else {
      console.error('Profile creation failed:', profileResponse.status, profileText);
      results.klaviyo.error = `Profile creation failed: ${profileResponse.status}`;
    }

    results.klaviyo.profile = profileId;

    // =====================
    // STEP 2: KLAVIYO - Subscribe to List (using profile-based subscription)
    // =====================
    if (profileId) {
      // Build subscription channels
      const subscriptions = {
        email: {
          marketing: {
            consent: 'SUBSCRIBED'
          }
        }
      };
      
      if (formattedPhone) {
        subscriptions.sms = {
          marketing: {
            consent: 'SUBSCRIBED'
          }
        };
      }

      // Use the bulk subscription endpoint with email/phone identifiers
      const subscribePayload = {
        data: {
          type: 'profile-subscription-bulk-create-job',
          attributes: {
            custom_source: 'Cause Nomination Form',
            profiles: {
              data: [
                {
                  type: 'profile',
                  attributes: {
                    email: cleanEmail,
                    ...(formattedPhone && { phone_number: formattedPhone }),
                    subscriptions: subscriptions
                  }
                }
              ]
            }
          },
          relationships: {
            list: {
              data: {
                type: 'list',
                id: KLAVIYO_LIST_ID
              }
            }
          }
        }
      };

      console.log('=== KLAVIYO SUBSCRIPTION ===');
      console.log('List ID:', KLAVIYO_LIST_ID);
      console.log('Channels:', Object.keys(subscriptions).join(', '));

      const subscribeResponse = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
        method: 'POST',
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_PRIVATE_KEY}`,
          'Content-Type': 'application/vnd.api+json',  // Use JSON:API content type
          'revision': KLAVIYO_REVISION
        },
        body: JSON.stringify(subscribePayload)
      });

      const subscribeText = await subscribeResponse.text();
      console.log('Subscribe response:', subscribeResponse.status);
      
      if (subscribeResponse.status >= 200 && subscribeResponse.status < 300) {
        results.klaviyo.subscribed = true;
        console.log('Subscription job created successfully');
      } else {
        console.error('Subscription failed:', subscribeText);
        results.klaviyo.error = `Subscription failed: ${subscribeResponse.status}`;
      }
    }

    // =====================
    // STEP 3: QUO - Send Transactional SMS (if phone provided)
    // =====================
    if (formattedPhone && QUO_API_KEY) {
      console.log('=== QUO TRANSACTIONAL SMS ===');
      
      // Customize this message as needed
      const smsMessage = `Hi ${firstName}! 🎉 Thanks for nominating a cause with Good Laundry. We'll review "${causeName || 'your suggestion'}" and be in touch soon. Questions? Just reply to this text!`;
      
      const quoPayload = {
        content: smsMessage,
        to: [formattedPhone],
        ...(QUO_FROM_NUMBER && { from: QUO_FROM_NUMBER }),
        ...(QUO_PHONE_NUMBER_ID && { phoneNumberId: QUO_PHONE_NUMBER_ID }),
        setInboxStatus: 'done' // Mark as handled in Quo inbox
      };

      console.log('Sending to:', formattedPhone);
      console.log('Message length:', smsMessage.length);

      try {
        const quoResponse = await fetch('https://api.openphone.com/v1/messages', {
          method: 'POST',
          headers: {
            'Authorization': QUO_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(quoPayload)
        });

        const quoText = await quoResponse.text();
        console.log('Quo response:', quoResponse.status);

        if (quoResponse.ok) {
          results.quo.sent = true;
          console.log('Quo SMS sent successfully');
        } else {
          console.error('Quo SMS failed:', quoText);
          results.quo.error = `Quo failed: ${quoResponse.status}`;
        }
      } catch (quoError) {
        console.error('Quo API error:', quoError.message);
        results.quo.error = quoError.message;
      }
    } else if (formattedPhone && !QUO_API_KEY) {
      console.log('Quo SMS skipped: QUO_API_KEY not configured');
      results.quo.error = 'Quo not configured';
    } else {
      console.log('Quo SMS skipped: No phone number provided');
    }

    // =====================
    // RESPONSE
    // =====================
    return res.status(200).json({
      success: true,
      profile_id: results.klaviyo.profile,
      klaviyo_subscribed: results.klaviyo.subscribed,
      phone_included: !!formattedPhone,
      quo_sms_sent: results.quo.sent,
      message: 'Thank you for your nomination!',
      debug: {
        klaviyo_error: results.klaviyo.error,
        quo_error: results.quo.error
      }
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ 
      error: 'Server error', 
      details: error.message 
    });
  }
}
