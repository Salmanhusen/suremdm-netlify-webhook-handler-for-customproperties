// ============================================================================
// Webhook Handler for SureMDM - Netlify Function
// ============================================================================
// This function handles webhook events from SureMDM and updates device
// custom properties based on CSV data lookup by serial number
// ============================================================================

const { Buffer } = require('buffer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// ============================================================================
// Module-Level Cache
// ============================================================================
// CSV data is cached at module level to avoid re-reading on every request
let csvDataCache = null;
let csvLoadPromise = null;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Loads and parses CSV data from file system
 * @param {string} csvPath - Absolute path to CSV file
 * @returns {Promise<Array>} Array of CSV row objects
 */
async function loadCSVData(csvPath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        console.log(`CSV data loaded: ${results.length} rows`);
        resolve(results);
      })
      .on('error', (error) => {
        console.error('Error reading CSV:', error);
        reject(error);
      });
  });
}

/**
 * Gets CSV data with caching mechanism
 * First request loads from disk, subsequent requests use cache
 * @returns {Promise<Array>} Cached or newly loaded CSV data
 */
async function getCSVData() {
  // If data is already cached, return it immediately
  if (csvDataCache !== null) {
    console.log('Using cached CSV data');
    return csvDataCache;
  }

  // If a load is already in progress, wait for it
  if (csvLoadPromise !== null) {
    console.log('Waiting for CSV load in progress');
    return csvLoadPromise;
  }

  // Start loading the CSV
  console.log('Loading CSV data for the first time');
  const csvPath = path.join(process.cwd(), 'data', 'propExport.csv');

  csvLoadPromise = loadCSVData(csvPath)
    .then((data) => {
      csvDataCache = data;
      csvLoadPromise = null;
      return data;
    })
    .catch((error) => {
      console.error('Failed to load CSV:', error);
      csvLoadPromise = null;
      return []; // Return empty array on error
    });

  return csvLoadPromise;
}

/**
 * Looks up custom properties from CSV data by serial number
 * @param {Array} csvData - Array of CSV row objects
 * @param {string} serialNumber - Device serial number to search for
 * @returns {Array} Matching custom property records
 */
function lookupCustomProperties(csvData, serialNumber) {
  if (!serialNumber || !csvData) {
    return [];
  }
  return csvData.filter((row) => row.SerialNumber === serialNumber);
}

// ============================================================================
// Main Webhook Handler
// ============================================================================

export default async (request) => {
  console.log('=== Webhook Handler Started ===');

  // --------------------------------------------------------------------------
  // Step 1: Load CSV Data (cached)
  // --------------------------------------------------------------------------
  const csvData = await getCSVData();

  // --------------------------------------------------------------------------
  // Step 2: Log Request Information
  // --------------------------------------------------------------------------
  const ip = request.headers.get('x-nf-client-connection-ip');
  const domain = request.headers.get('host');
  const contentType = request.headers.get('content-type');
  const userAgent = request.headers.get('user-agent');

  console.log(`Request from IP: ${ip}, Domain: ${domain}`);
  console.log(`Content-Type: ${contentType}`);
  console.log(`User-Agent: ${userAgent}`);
  console.log(`Method: ${request.method}`);

  // --------------------------------------------------------------------------
  // Step 3: Parse Request Body
  // --------------------------------------------------------------------------
  let body;
  try {
    const rawBody = await request.text();
    console.log('Raw request body:', rawBody);
    console.log('Raw body length:', rawBody.length);

    // Check if body is empty
    if (!rawBody || rawBody.trim() === '') {
      console.log('Empty request body - connection test');
      return new Response(
        'Webhook endpoint is working. Send JSON data with EventType and DeviceId.',
        {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }
      );
    }

    // Try to parse JSON
    body = JSON.parse(rawBody);
  } catch (error) {
    console.error('Invalid JSON:', error);
    console.error('Error details:', error.message);
    return new Response(`Invalid JSON body. Error: ${error.message}`, {
      status: 400,
    });
  }

  // --------------------------------------------------------------------------
  // Step 4: Validate Required Fields
  // --------------------------------------------------------------------------
  console.log('Received webhook:', body);

  if (!body.EventType || !body.DeviceId) {
    return new Response('Missing required fields (EventType or DeviceId)', {
      status: 400,
    });
  }

  const deviceId = body.DeviceId;
  console.log('Processing event type:', body.EventType);

  // --------------------------------------------------------------------------
  // Step 5: Fetch Device Details from SureMDM API
  // --------------------------------------------------------------------------
  let deviceName = 'Unknown Device';
  let imei = 'N/A';
  let macAddress = 'N/A';
  let deviceData = null;
  let apiUrl = null;
  let serialNumber = null;

  // Check if this is a delete event
  const isDeleteEvent = body.EventType === 'Device Deletion';

  if (!isDeleteEvent) {
    // For non-delete events, fetch device details
    try {
      const authHeader =
        'Basic ' +
        Buffer.from(
          `${process.env.SUREMDM_API_USERNAME}:${process.env.SUREMDM_API_PASSWORD}`
        ).toString('base64');

      apiUrl = `${process.env.SUREMDM_API_URL}/v2/device/${deviceId}`;
      console.log('Fetching device details from:', apiUrl);

      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          ApiKey: process.env.SUREMDM_API_KEY,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.warn(
          `Could not fetch device details: ${response.status} ${response.statusText}`
        );
      } else {
        deviceData = await response.json();
        console.log('Received deviceData:', deviceData);

        if (
          deviceData &&
          deviceData.data &&
          deviceData.data.rows &&
          deviceData.data.rows.length > 0
        ) {
          const device = deviceData.data.rows[0];
          deviceName = device.DeviceName || 'Unknown Device';
          imei = device.IMEI || 'N/A';
          macAddress = device.MacAddress || 'N/A';
          serialNumber = device.SerialNumber || 'N/A';
          console.log('Successfully fetched device details');
        } else {
          return new Response('device not found on suremdm', {
                              status: 400,
                            });
        }
      }
    } catch (apiError) {
      console.warn('Error fetching device details:', apiError.message);
      // Continue with default values instead of failing
    }
  } else {
    console.log('Delete event detected - skipping device details fetch');
    deviceName = `Device ${deviceId} (Deleted)`;
  }

  // --------------------------------------------------------------------------
  // Step 6: Lookup Custom Properties from CSV
  // --------------------------------------------------------------------------
  let customProperties = [];

  if (serialNumber && serialNumber !== 'N/A') {
    customProperties = lookupCustomProperties(csvData, serialNumber);
    console.log(
      `Found ${customProperties.length} custom properties for serial number: ${serialNumber}`
    );

    if (customProperties.length > 0) {
      console.log('Custom properties:', JSON.stringify(customProperties));
    }
  } else {
    console.log('No serial number available for CSV lookup');
  }

  // --------------------------------------------------------------------------
  // Step 7: Update Device Custom Properties via SureMDM API
  // --------------------------------------------------------------------------
  try {
    if (!serialNumber || serialNumber === 'N/A') {
      return new Response('No serial number available - cannot lookup properties in CSV', {
        status: 400,
      });
    }

    if (customProperties.length === 0) {
      return new Response('No custom properties found in CSV for this serial number', {
        status: 400,
      });
    }

    // Prepare property data for API update
    // Iterate through all custom properties and create update objects
    const propertyData = [];
    
    for (const property of customProperties) {
      const customPropertyEdit = {
        _id: deviceId, // MongoDB ObjectId or device identifier
        CustomPropertiesKey: property.Propertyname, // Custom property name/key
        CustomAttributeExistingKey: "", // Existing key if renaming
        CustomPropertiesValue: property.Value, // Custom property value
      };
      propertyData.push(customPropertyEdit);
    }

    console.log(`Prepared ${propertyData.length} property updates for device ${deviceId}`);

    // Call SureMDM API to update properties
    const authHeader =
      'Basic ' +
      Buffer.from(
        `${process.env.SUREMDM_API_USERNAME}:${process.env.SUREMDM_API_PASSWORD}`
      ).toString('base64');

    apiUrl = `${process.env.SUREMDM_API_URL}/v2/UpdatePropertiesValue`;

    const response2 = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        Authorization: authHeader,
        ApiKey: process.env.SUREMDM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(propertyData),
    });

    if (!response2.ok) {
      throw new Error(
        `SureMDM API error: ${response2.status} ${response2.statusText}`
      );
    }

    const result = await response2.json();
    console.log('SureMDM API response:', result);

    const responseData = {
      message: 'Webhook received and processed successfully',
      receivedEvent: body.EventType,
      deviceId: deviceId,
      apiUrl: apiUrl,
      editResponse : result,
      deviceDetails: {
        name: deviceName,
        imei: imei,
        macAddress: macAddress,
        serialNumber: serialNumber,
      },
      customProperties: customProperties,
      timestamp: new Date().toISOString(),
    };

    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error processing webhook:', error);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
};