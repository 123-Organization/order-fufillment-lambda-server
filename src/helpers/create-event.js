const finerworksService = require('./finerworks-service');
const createEvent = async (eventType, eventName, eventDetails, eventSiteId = 1) => {
    const payload = {
      type: eventType,
      name: eventName,
      details: eventDetails,
      account_id: 0,
      site_id: eventSiteId
    }
    const logData = await finerworksService.LOG_EVENT(payload);
    return logData.event_log ?? logData;
}
module.exports = createEvent;