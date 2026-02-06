import { h } from 'preact';

interface ClosestFlightCardProps {
  airline: string;
  route: string;
  aircraft: string;
  icao24: string;
}

export function ClosestFlightCard({ airline, route, aircraft, icao24 }: ClosestFlightCardProps) {
  return (
    <div className="bg-white shadow-md rounded-lg p-4 max-w-md mx-auto text-center border border-gray-200">
      {/* Airline at top */}
      <h2 className="text-xl font-bold text-blue-700 mb-2">
        {airline || 'Unknown Airline'}
      </h2>

      {/* Route */}
      <p className="text-gray-700 text-md mb-1">
        {route || 'Unknown Route'}
      </p>

      {/* Aircraft */}
      <p className="text-lg font-semibold text-gray-900 mb-1">
        ✈ {aircraft || 'Unknown Aircraft'}
      </p>

      {/* ICAO24 */}
      <p className="text-sm text-gray-500 mt-2">
        ICAO24: {icao24 || 'N/A'}
      </p>
    </div>
  );
}
