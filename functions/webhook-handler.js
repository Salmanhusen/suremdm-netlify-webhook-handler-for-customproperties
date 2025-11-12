// This is the main entry point for the webhook handler
const { Buffer } = require('buffer');
const fs = require('fs');
const csv = require('csv-parser');

// functions/webhook-handler.js
export default async (request) => {
  console.log('+webhook-handler.js');
  

const results = [];
fs.createReadStream('data/propExport.csv')
  .pipe(csv())
  .on('data', (data) => results.push(data))
  .on('end', () => {
    // Now 'results' contains your parsed CSV data as an array of objects
    // You can use this data to generate static pages, JSON files, etc.
    // fs.writeFileSync('public/data.json', JSON.stringify(results));
    console.log('CSV data processed and saved to public/data.json');
  });
console.log(`data from csv: ${JSON.stringify(results)}`);
  // Log the caller's IP address and domain information
  const ip = request.headers.get('x-nf-client-connection-ip');
  const domain = request.headers.get('host');
  const contentType = request.headers.get('content-type');
  const userAgent = request.headers.get('user-agent');
  
  console.log(`Request from IP: ${ip}, Domain: ${domain}`);
  console.log(`Content-Type: ${contentType}`);
  console.log(`User-Agent: ${userAgent}`);
  console.log(`Method: ${request.method}`);

  // Parse the JSON body
  let body;
  try {
    // First, get the raw text to see what we're receiving
    const rawBody = await request.text();
    console.log('Raw request body:', rawBody);
    console.log('Raw body length:', rawBody.length);
    
    // Check if body is empty
    if (!rawBody || rawBody.trim() === '') {
      console.log('Empty request body received - this might be a connection test');
      return new Response('Webhook endpoint is working. Send JSON data with EventType and DeviceId.', { 
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    // Try to parse JSON
    body = JSON.parse(rawBody);
  } catch (error) {
    console.error('Invalid JSON:', error);
    console.error('Error details:', error.message);
    return new Response(`Invalid JSON body. Error: ${error.message}`, { status: 400 });
  }

  // Simple processing: Log the payload and check for a required field
  console.log('Received webhook:', body);
  if (!body.EventType || !body.DeviceId) {
    return new Response('Missing required fields (event or data)', { status: 400 });
  }
   
  // Extract device ID from payload
  const deviceId = body.DeviceId;
  if (!deviceId) {
    return new Response('Missing deviceId in payload', { status: 400 });
  }

  // Your custom logic here 
  // Handle different event types appropriately
  console.log('Processing event type:', body.EventType);
  
  let deviceName = 'Unknown Device';
  let imei = 'N/A';
  let macAddress = 'N/A';
  let deviceData = null;
  let apiUrl = null;
  let serialNumber = null;

  // Check if this is a delete event - don't try to fetch device details for deleted devices
  const isDeleteEvent = body.EventType === 'Device Deletion';
  
  if (!isDeleteEvent) {
    // For non-delete events, try to fetch device details
    try {
      const authHeader = "Basic " + Buffer.from(process.env.SUREMDM_API_USERNAME + ":" + process.env.SUREMDM_API_PASSWORD).toString("base64");

      apiUrl = process.env.SUREMDM_API_URL + "/v2/device/" + deviceId;
      console.log('Fetching device details from:', apiUrl);
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          ApiKey: process.env.SUREMDM_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.warn(`Could not fetch device details: ${response.status} ${response.statusText}`);
        // Don't throw error, continue with default values
      } else {
        deviceData = await response.json();
        console.log('Received deviceData:', deviceData);
        
        if (deviceData && deviceData.data && deviceData.data.rows && deviceData.data.rows.length > 0) {
          // Extract specific fields (adjust keys based on actual API response structure)
          deviceName = deviceData.data.rows[0].DeviceName || 'Unknown Device';
          imei = deviceData.data.rows[0].IMEI || 'N/A';
          macAddress = deviceData.data.rows[0].MacAddress || 'N/A';
          serialNumber= deviceData.data.rows[0].SerialNumber || 'N/A';
          console.log('Successfully fetched device details');
        } else {
          console.warn('Device details not found in API response');
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

  // Send email notification and prepare response
  try {
    // // For now, include fetched data in response
    // const responseData = {
    //   message: 'Webhook received and processed successfully',
    //   receivedEvent: body.EventType,
    //   deviceId: deviceId,
    //   apiUrl: apiUrl,
    //   deviceDetails: {
    //     name: deviceName,
    //     imei: imei,
    //     macAddress: macAddress,
    //     serialNumber: serialNumber
    //   },
    //   timestamp: new Date().toISOString()
    // };

    // var nodemailer = require('nodemailer');

    // var transporter = nodemailer.createTransport({
    //   service: "gmail",
    //   host: "smtp.gmail.com",
    //   port: 587,
    //   secure: false, // true for 465, false for other ports
    //   auth: {
    //     user: process.env.GMAIL_USERNAME, 
    //     pass: process.env.GMAIL_APP_PASSWORD 
    //   }
    // });

    // const emailBody = `
    //   Webhook Event: ${body.EventType}
    //   Device ID: ${deviceId}
    //   Device Name: ${deviceName}
    //   IMEI: ${imei}
    //   MAC Address: ${macAddress}
    //   Timestamp: ${new Date().toISOString()}
    //   Serial Number: ${serialNumber}
    // `;

    // await transporter.sendMail({
    //   from: "Device Alert"  + process.env.GMAIL_SENDER_ADDRESS,
    //   to: process.env.SEND_TO_EMAIL_ADDERESS,
    //   subject: `Device Alert: ${deviceName}`,
    //   text: emailBody,
    //   html: `<pre>${emailBody}</pre>`
    // });

    // console.log('Email sent via Gmail!');
    
    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error processing webhook:', error);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
};