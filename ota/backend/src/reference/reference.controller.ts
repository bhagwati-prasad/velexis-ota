// The reference operations of the OTA document (`x-scope: both`, ota/docs/scope.md §3.1): edge and key callers, with
// the tenant resolved by the global guards. The answers are the same for every tenant and change only when the
// reference data is reloaded, so they carry `Cache-Control: public, max-age=3600`; the error filter replaces it with
// `no-store` on errors. The operations whose names follow `Accept-Language` also say `Vary: Accept-Language`.
import { Controller, Get, Header } from "@nestjs/common";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import type {
  Airline,
  AirlinePage,
  Airport,
  CountryPage,
  CurrencyPage,
  LocationPage,
} from "./reference.mapper";
import { ReferenceService } from "./reference.service";

/** The `Cache-Control` of every successful reference answer (OBE-015 step 2). */
export const REFERENCE_CACHE_CONTROL = "public, max-age=3600";

@Controller("v1/reference")
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  @Get("locations")
  @OpenApiOperation("searchLocations")
  @Header("Cache-Control", REFERENCE_CACHE_CONTROL)
  searchLocations(@OpenApiInput() input: ValidatedInput<"searchLocations">): Promise<LocationPage> {
    return this.reference.searchLocations(input.query);
  }

  @Get("airports/:iataCode")
  @OpenApiOperation("getAirport")
  @Header("Cache-Control", REFERENCE_CACHE_CONTROL)
  @Header("Vary", "Accept-Language")
  getAirport(@OpenApiInput() input: ValidatedInput<"getAirport">): Promise<Airport> {
    return this.reference.getAirport(input.path.iataCode, input.headers?.["Accept-Language"]);
  }

  @Get("airlines")
  @OpenApiOperation("listAirlines")
  @Header("Cache-Control", REFERENCE_CACHE_CONTROL)
  listAirlines(@OpenApiInput() input: ValidatedInput<"listAirlines">): Promise<AirlinePage> {
    return this.reference.listAirlines(input.query ?? {});
  }

  @Get("airlines/:iataCode")
  @OpenApiOperation("getAirline")
  @Header("Cache-Control", REFERENCE_CACHE_CONTROL)
  getAirline(@OpenApiInput() input: ValidatedInput<"getAirline">): Promise<Airline> {
    return this.reference.getAirline(input.path.iataCode);
  }

  @Get("countries")
  @OpenApiOperation("listCountries")
  @Header("Cache-Control", REFERENCE_CACHE_CONTROL)
  @Header("Vary", "Accept-Language")
  listCountries(@OpenApiInput() input: ValidatedInput<"listCountries">): Promise<CountryPage> {
    return this.reference.listCountries(input.query ?? {}, input.headers?.["Accept-Language"]);
  }

  @Get("currencies")
  @OpenApiOperation("listCurrencies")
  @Header("Cache-Control", REFERENCE_CACHE_CONTROL)
  @Header("Vary", "Accept-Language")
  listCurrencies(@OpenApiInput() input: ValidatedInput<"listCurrencies">): Promise<CurrencyPage> {
    return this.reference.listCurrencies(input.query ?? {}, input.headers?.["Accept-Language"]);
  }
}
