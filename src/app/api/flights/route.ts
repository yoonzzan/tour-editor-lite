// src/app/api/flights/route.ts — T-602
// Mock 항공 데이터 반환

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import flightsMock from "@/mocks/flights.json";
import { requireConverterAccess } from "@/lib/converter/access";

export type FlightFareType = "INDIVIDUAL" | "GROUP";
export type FlightTripType = "ONE_WAY" | "ROUND_TRIP";
export type FlightDirection = "DEPARTURE" | "RETURN";

export interface FlightSegment {
  airline: string;
  flightNo: string;
  depAirport: string;
  arrAirport: string;
  depTime: string;
  arrTime: string;
}

interface FlightFareOptionBase {
  id: string;
  airline: string;
  fareAdult: number;
  fuelSurcharge: number;
  tax: number;
  total: number;
}

export type FlightFareOption =
  | (FlightFareOptionBase & {
      fareType: "INDIVIDUAL";
      tripType: "ONE_WAY";
      outbound: FlightSegment;
    })
  | (FlightFareOptionBase & {
      fareType: FlightFareType;
      tripType: "ROUND_TRIP";
      outbound: FlightSegment;
      inbound: FlightSegment;
    });

export async function GET(req: NextRequest) {
  const accessError = requireConverterAccess(req);
  if (accessError) return accessError;

  const mode = req.nextUrl.searchParams.get("mode");
  const tripType = mode === "ONE_WAY" || mode === "ROUND_TRIP" ? mode : req.nextUrl.searchParams.get("tripType");
  const depAirport = req.nextUrl.searchParams.get("depAirport") ?? req.nextUrl.searchParams.get("departureAirport");
  const destinationAirport =
    req.nextUrl.searchParams.get("destinationAirport") ?? req.nextUrl.searchParams.get("arrivalAirport");
  const returnDepartureAirport = req.nextUrl.searchParams.get("returnDepartureAirport");
  const returnArrivalAirport = req.nextUrl.searchParams.get("returnArrivalAirport");
  const schedules = (flightsMock as FlightFareOption[]).filter((schedule) => {
    if (tripType !== "ONE_WAY" && tripType !== "ROUND_TRIP") return true;
    if (schedule.tripType !== tripType) return false;
    if (tripType === "ONE_WAY" && schedule.fareType !== "INDIVIDUAL") return false;
    if (depAirport && schedule.outbound.depAirport !== depAirport) return false;
    if (destinationAirport && schedule.outbound.arrAirport !== destinationAirport) return false;
    if (tripType === "ROUND_TRIP") {
      if (schedule.tripType !== "ROUND_TRIP") return false;
      if (returnDepartureAirport && schedule.inbound.depAirport !== returnDepartureAirport) return false;
      if (returnArrivalAirport && schedule.inbound.arrAirport !== returnArrivalAirport) return false;
    }
    return true;
  });

  return NextResponse.json({ schedules });
}
