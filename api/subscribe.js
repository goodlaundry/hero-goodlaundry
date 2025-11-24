// api/subscribe.js - Vercel Serverless Function for Klaviyo Subscription
// SECURE VERSION - Uses environment variables for API keys

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

  // Configuration - Get private key from environment variable (NEVER hardcode!)
  const PRIVATE_KEY = process.env.KLAVIYO_PRIVATE_KEY;
  const LIST_ID = process.env.KLAVIYO_LIST_ID || 'SWfNg6';
  const API_REVISION = '2025-04-15';

  // Check that the environment variable is set
  if (!PRIVATE_KEY) {
    console.error('KLAVIYO_PRIVATE_KEY environment variable is not set!');
    return res.status(500).json({ 
      error: 'Server configuration error', 
      details: 'API key not configured. Please set KLAVIYO_PRIVATE_KEY in Vercel environment variables.' 
    });
  }

  const cleanEmail = email.toLowerCase().trim();

  // Format phone if provided
  let formattedPhone = null;
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) {
      formattedPhone = '+1' + digits;
    } else if (digits.length === 11 && digits.startsWith('1')) {
      formattedPhone = '+' + digits;
    }
  }

  try {
    // STEP 1: Create Profile
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

    console.log('Creating profile for:', cleanEmail);

    const profileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${PRIVATE_KEY}`,
        'Content-Type': 'application/json',
        'revision': API_REVISION
      },
      body: JSON.stringify(profilePayload)
    });

    let profileId = null;
    const profileText = await profileResponse.text();
    console.log('Profile response:', profileResponse.status, profileText);

    if (profileResponse.status === 201) {
      const profileData = JSON.parse(profileText);
      profileId = profileData.data?.id;
      console.log('New profile created:', profileId);
    } else if (profileResponse.status === 409) {
      const profileData = JSON.parse(profileText);
      profileId = profileData.errors?.[0]?.meta?.duplicate_profile_id;
      console.log('Duplicate profile found:', profileId);
    } else {
      console.error('Profile creation failed:', profileResponse.status);
      return res.status(500).json({ 
        error: 'Failed to create profile', 
        status: profileResponse.status,
        details: profileText 
      });
    }

    if (!profileId) {
      return res.status(500).json({ error: 'Failed to get profile ID' });
    }

    // STEP 2: Subscribe to Email
    const subscribePayload = {
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: {
          custom_source: 'Cause Nomination Form',
          profiles: {
            data: [
              {
                type: 'profile',
                id: profileId,
                attributes: {
                  email: cleanEmail,
                  subscriptions: {
                    email: {
                      marketing: {
                        consent: 'SUBSCRIBED'
                      }
                    }
                  }
                }
              }
            ]
          }
        },
        relationships: {
          list: {
            data: {
              type: 'list',
              id: LIST_ID
            }
          }
        }
      }
    };

    console.log('Subscribing profile:', profileId);

    const subscribeResponse = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${PRIVATE_KEY}`,
        'Content-Type': 'application/json',
        'revision': API_REVISION
      },
      body: JSON.stringify(subscribePayload)
    });

    const subscribeText = await subscribeResponse.text();
    console.log('Subscribe response:', subscribeResponse.status, subscribeText);

    const subscribeSuccess = subscribeResponse.status >= 200 && subscribeResponse.status < 300;

    return res.status(200).json({
      success: true,
      profile_id: profileId,
      subscribed: subscribeSuccess,
      subscribe_status: subscribeResponse.status,
      message: 'Thank you for your nomination!'
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Server error', details: error.message });
  }
}
