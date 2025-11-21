<?php
// test_api.php - Simple test to verify PHP and Klaviyo API connection
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$PRIVATE_KEY = 'pk_1730e9f934245949c7097b13b459ee070d';
$API_REVISION = '2025-04-15';

// Test 1: PHP is working
$result = [
    'php_working' => true,
    'timestamp' => date('Y-m-d H:i:s'),
    'php_version' => phpversion()
];

// Test 2: cURL is available
$result['curl_available'] = function_exists('curl_init');

// Test 3: Test Klaviyo API connection (simple GET to check auth)
if ($result['curl_available']) {
    $ch = curl_init('https://a.klaviyo.com/api/lists/');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            'Authorization: Klaviyo-API-Key ' . $PRIVATE_KEY,
            'revision: ' . $API_REVISION
        ]
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);
    
    $result['klaviyo_api_test'] = [
        'http_code' => $httpCode,
        'success' => ($httpCode === 200),
        'error' => $curlError ?: null
    ];
    
    // If successful, show list count
    if ($httpCode === 200) {
        $data = json_decode($response, true);
        $result['klaviyo_api_test']['list_count'] = count($data['data'] ?? []);
    }
}

echo json_encode($result, JSON_PRETTY_PRINT);
?>
