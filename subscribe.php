<?php
/**
 * Good Laundry - Cause Nomination Subscription
 * Uses SERVER-SIDE API (like working submit.php)
 * API Revision: 2025-04-15
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);
ini_set('error_log', __DIR__ . '/subscribe_errors.log');

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit(json_encode(['error' => 'Method not allowed']));
}

$input = json_decode(file_get_contents('php://input'), true);

// Validate required fields
if (empty($input['email']) || empty($input['firstName']) || empty($input['lastName'])) {
    http_response_code(400);
    exit(json_encode(['error' => 'Missing required fields (email, firstName, lastName)']));
}

if (!filter_var($input['email'], FILTER_VALIDATE_EMAIL)) {
    http_response_code(400);
    exit(json_encode(['error' => 'Invalid email format']));
}

// Configuration - Good Laundry Klaviyo API
$PRIVATE_KEY = 'pk_1730e9f934245949c7097b13b459ee070d';
$LIST_ID = 'SWfNg6'; // Good Laundry Cause Nomination list
$API_REVISION = '2025-04-15';

// Process inputs
$email = trim(strtolower($input['email']));
$firstName = trim($input['firstName']);
$lastName = trim($input['lastName']);
$causeName = trim($input['causeName'] ?? '');
$causeLocation = trim($input['causeLocation'] ?? '');
$causeWhy = trim($input['causeWhy'] ?? '');

// Format phone if provided
$phone = null;
if (!empty($input['phone'])) {
    $digits = preg_replace('/[^0-9]/', '', $input['phone']);
    if (strlen($digits) === 10) {
        $phone = '+1' . $digits;
    } elseif (strlen($digits) === 11 && substr($digits, 0, 1) === '1') {
        $phone = '+' . $digits;
    }
}

/**
 * STEP 1: Create or Update Profile
 */
$profilePayload = [
    'data' => [
        'type' => 'profile',
        'attributes' => [
            'email' => $email,
            'first_name' => $firstName,
            'last_name' => $lastName,
            'properties' => [
                'Cause Name' => $causeName ?: 'Choose for me',
                'Cause Location' => $causeLocation,
                'Cause Why' => $causeWhy,
                'Source' => 'Cause Nomination Form',
                'signup_date' => date('Y-m-d H:i:s')
            ]
        ]
    ]
];

if ($phone) {
    $profilePayload['data']['attributes']['phone_number'] = $phone;
}

$ch = curl_init('https://a.klaviyo.com/api/profiles/');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($profilePayload),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_HTTPHEADER => [
        'Authorization: Klaviyo-API-Key ' . $PRIVATE_KEY,
        'Content-Type: application/json',
        'revision: ' . $API_REVISION
    ]
]);

$profileResponse = curl_exec($ch);
$profileHttpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($curlError) {
    error_log("CURL Error: " . $curlError);
    http_response_code(500);
    exit(json_encode(['error' => 'Network error', 'details' => $curlError]));
}

$profileData = json_decode($profileResponse, true);
$profileId = null;

// New profile created
if ($profileHttpCode === 201 && isset($profileData['data']['id'])) {
    $profileId = $profileData['data']['id'];
    error_log("New profile created: $profileId for $email");
}
// Duplicate - get existing profile ID
elseif ($profileHttpCode === 409) {
    if (isset($profileData['errors'][0]['meta']['duplicate_profile_id'])) {
        $profileId = $profileData['errors'][0]['meta']['duplicate_profile_id'];
        error_log("Duplicate profile found: $profileId for $email");
        
        // Update existing profile with new data
        $updatePayload = [
            'data' => [
                'type' => 'profile',
                'id' => $profileId,
                'attributes' => [
                    'first_name' => $firstName,
                    'last_name' => $lastName,
                    'properties' => [
                        'Cause Name' => $causeName ?: 'Choose for me',
                        'Cause Location' => $causeLocation,
                        'Cause Why' => $causeWhy,
                        'Source' => 'Cause Nomination Form',
                        'last_nomination_date' => date('Y-m-d H:i:s')
                    ]
                ]
            ]
        ];
        
        if ($phone) {
            $updatePayload['data']['attributes']['phone_number'] = $phone;
        }
        
        $ch = curl_init("https://a.klaviyo.com/api/profiles/$profileId/");
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => 'PATCH',
            CURLOPT_POSTFIELDS => json_encode($updatePayload),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_HTTPHEADER => [
                'Authorization: Klaviyo-API-Key ' . $PRIVATE_KEY,
                'Content-Type: application/json',
                'revision: ' . $API_REVISION
            ]
        ]);
        curl_exec($ch);
        curl_close($ch);
    } else {
        error_log("409 error but no duplicate ID: " . $profileResponse);
        http_response_code(500);
        exit(json_encode(['error' => 'Profile conflict']));
    }
}
else {
    error_log("Profile creation failed. HTTP $profileHttpCode: " . $profileResponse);
    http_response_code(500);
    exit(json_encode(['error' => 'Failed to create profile', 'status' => $profileHttpCode]));
}

if (!$profileId) {
    error_log("No profile ID obtained for $email");
    http_response_code(500);
    exit(json_encode(['error' => 'Failed to get profile ID']));
}

/**
 * STEP 2: Subscribe to Email Marketing (and SMS if phone provided)
 */
error_log("=== STARTING SUBSCRIPTION FOR $email (profile: $profileId) ===");

$subscriptionAttributes = [
    'email' => $email,
    'subscriptions' => [
        'email' => [
            'marketing' => [
                'consent' => 'SUBSCRIBED'
            ]
        ]
    ]
];

// Add SMS subscription if phone provided
if ($phone) {
    $subscriptionAttributes['phone_number'] = $phone;
    $subscriptionAttributes['subscriptions']['sms'] = [
        'marketing' => [
            'consent' => 'SUBSCRIBED'
        ]
    ];
    error_log("Including SMS subscription for $phone");
}

$subscribePayload = [
    'data' => [
        'type' => 'profile-subscription-bulk-create-job',
        'attributes' => [
            'custom_source' => 'Cause Nomination Form',
            'profiles' => [
                'data' => [
                    [
                        'type' => 'profile',
                        'id' => $profileId,
                        'attributes' => $subscriptionAttributes
                    ]
                ]
            ]
        ],
        'relationships' => [
            'list' => [
                'data' => [
                    'type' => 'list',
                    'id' => $LIST_ID
                ]
            ]
        ]
    ]
];

error_log("Subscription payload: " . json_encode($subscribePayload));

$ch = curl_init('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($subscribePayload),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_HTTPHEADER => [
        'Authorization: Klaviyo-API-Key ' . $PRIVATE_KEY,
        'Content-Type: application/json',
        'revision: ' . $API_REVISION
    ]
]);

$subscribeResponse = curl_exec($ch);
$subscribeHttpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlSubError = curl_error($ch);
curl_close($ch);

error_log("Subscription API response: HTTP $subscribeHttpCode");
error_log("Subscription API body: " . $subscribeResponse);
if ($curlSubError) {
    error_log("Subscription CURL error: " . $curlSubError);
}

$subscribeSuccess = false;
if ($subscribeHttpCode >= 200 && $subscribeHttpCode < 300) {
    error_log("✅ Subscription successful for $email (profile: $profileId)");
    $subscribeSuccess = true;
} else {
    error_log("❌ Subscription failed. HTTP $subscribeHttpCode: " . $subscribeResponse);
}

// Return success with debug info
http_response_code(200);
echo json_encode([
    'success' => true,
    'profile_id' => $profileId,
    'subscribed' => $subscribeSuccess,
    'subscribe_http_code' => $subscribeHttpCode,
    'message' => 'Thank you for your nomination!'
]);
?>
