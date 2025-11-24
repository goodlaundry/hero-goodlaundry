// api/subscribe.js - Vercel Serverless Function for Klaviyo Subscription
// SECURE VERSION - Uses environment variables for API keys
// FIXED: Phone number handling and subscription payload format

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

  // Configuration - Get from environment variables (NEVER hardcode!)
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

  // Format phone if provided (must be E.164 format: +15551234567)
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
    // STEP 1: Create/Update Profile with all data including phone
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

    console.log('Creating profile for:', cleanEmail, formattedPhone ? `with phone ${formattedPhone}` : 'no phone');

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
      // Profile already exists - get the ID and update it
      const profileData = JSON.parse(profileText);
      profileId = profileData.errors?.[0]?.meta?.duplicate_profile_id;
      console.log('Duplicate profile found:', profileId);
      
      // Update existing profile with phone and custom properties
      if (profileId) {
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
                'signup_date': new Date().toISOString()
              }
            }
          }
        };
        
        if (formattedPhone) {
          updatePayload.data.attributes.phone_number = formattedPhone;
        }
        
        console.log('Updating existing profile with new data...');
        const updateResponse = await fetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Klaviyo-API-Key ${PRIVATE_KEY}`,
            'Content-Type': 'application/json',
            'revision': API_REVISION
          },
          body: JSON.stringify(updatePayload)
        });
        console.log('Profile update response:', updateResponse.status);
      }
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

    // STEP 2: Subscribe to Email (and SMS if phone provided)
    // Build the subscription object dynamically
    const subscriptions = {
      email: {
        marketing: {
          consent: 'SUBSCRIBED'
        }
      }
    };
    
    // Add SMS subscription if phone is provided
    if (formattedPhone) {
      subscriptions.sms = {
        marketing: {
          consent: 'SUBSCRIBED'
        }
      };
    }

    const profileAttributes = {
      email: cleanEmail,
      subscriptions: subscriptions
    };
    
    // Include phone in subscription payload if provided
    if (formattedPhone) {
      profileAttributes.phone_number = formattedPhone;
    }

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
                attributes: profileAttributes
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
    console.log('Subscribe payload:', JSON.stringify(subscribePayload, null, 2));

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
      phone_included: !!formattedPhone,
      message: 'Thank you for your nomination!'
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Server error', details: error.message });
  }
}
