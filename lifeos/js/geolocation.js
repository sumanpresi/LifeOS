/* Browser geolocation, shared by every "my location" button on any map. */
export function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("Geolocation isn't available in this browser")); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve([pos.coords.latitude, pos.coords.longitude]),
      err => {
        const messages = {
          1: "Location access was denied — check your browser/device location permission for this site.",
          2: "Your location couldn't be determined right now.",
          3: "Getting your location took too long — try again."
        };
        reject(new Error(messages[err.code] || "Couldn't get your location."));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}
