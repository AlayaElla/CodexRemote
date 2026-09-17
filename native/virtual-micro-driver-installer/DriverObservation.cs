namespace VirtualMicroBroker;

// The installer needs only this value type from the ordinary broker's status
// implementation. Keeping it local avoids linking the broker's JSON endpoint
// into the NativeAOT executable.
internal record DriverObservation(bool Installed, bool Ready);
