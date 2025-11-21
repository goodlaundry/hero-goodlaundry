// api/subscribe.js - Vercel Serverless Function for Klaviyo Subscription
// Place this file in /api/subscribe.js in your Vercel project

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

  // Configuration - Good Laundry Klaviyo API
  const PRIVATE_KEY = 'pk_1730e9f934245949c7097b13b459ee070d';
  const LIST_ID = 'SWfNg6';
  const API_REVISION = '2025-10-15'; // Match working PHP revision

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
    // STEP 1: Create or Update Profile
    const profilePayload = {
      data: {
        type: 'profile',
        attributes: {
          email: email.toLowerCase().trim(),
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
      profilePayload.data.attributes.phone_number = formattedPhone;
    }

    console.log('Creating profile for:', email);

    const profileResponse = await fetch('https://a.klaviyo.com/api/profiles/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${PRIVATE_KEY}`,
        'Content-Type': 'application/json',
        'revision': API_REVISION
      },
      body: JSON.stringify(profilePayload)
    });

    const profileData = await profileResponse.json();
    let profileId = null;

    if (profileResponse.status === 201 && profileData.data?.id) {
      profileId = profileData.data.id;
      console.log('New profile created:', profileId);
    } else if (profileResponse.status === 409) {
      // Duplicate - get existing profile ID
      profileId = profileData.errors?.[0]?.meta?.duplicate_profile_id;
      console.log('Duplicate profile found:', profileId);

      if (profileId) {
        // Update existing profile
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

        if (formattedPhone) {
          updatePayload.data.attributes.phone_number = formattedPhone;
        }

        await fetch(`https://a.klaviyo.com/api/profiles/${profileId}/`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Klaviyo-API-Key ${PRIVATE_KEY}`,
            'Content-Type': 'application/json',
            'revision': API_REVISION
          },
          body: JSON.stringify(updatePayload)
        });
      }
    } else {
      console.error('Profile creation failed:', profileData);
      return res.status(500).json({ error: 'Failed to create profile', details: profileData });
    }

    if (!profileId) {
      return res.status(500).json({ error: 'Failed to get profile ID' });
    }

    // STEP 2: Subscribe to Email Marketing
    // Small delay to ensure profile is fully created
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const subscriptionAttributes = {
      email: email.toLowerCase().trim(),
      subscriptions: {
        email: {
          marketing: {
            consent: 'SUBSCRIBED'
          }
        }
      }
    };

    if (formattedPhone) {
      subscriptionAttributes.phone_number = formattedPhone;
      subscriptionAttributes.subscriptions.sms = {
        marketing: {
          consent: 'SUBSCRIBED'
        }
      };
    }

    // Try WITHOUT profile ID - just use email
    const subscribePayload = {
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: {
          custom_source: 'Cause Nomination Form',
          profiles: {
            data: [
              {
                type: 'profile',
                attributes: subscriptionAttributes
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

    const subscribeResponseText = await subscribeResponse.text();
    console.log('Subscribe response status:', subscribeResponse.status);
    console.log('Subscribe response body:', subscribeResponseText);

    const subscribeSuccess = subscribeResponse.status >= 200 && subscribeResponse.status < 300;
    
    if (subscribeSuccess) {
      console.log('Subscription successful for:', email);
    } else {
      console.error('Subscription failed:', subscribeResponse.status, subscribeResponseText);
    }

    return res.status(200).json({
      success: true,
      profile_id: profileId,
      subscribed: subscribeSuccess,
      subscribe_http_code: subscribeResponse.status,
      subscribe_response: subscribeResponseText || null,
      debug_payload_sent: subscribePayload,
      message: 'Thank you for your nomination!'
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Server error', details: error.message });
  }
}
