// `flights.search`, `flights.getSearch` and `flights.listResults` (createFlightSearch, getFlightSearch,
// listFlightSearchResults; `x-scope: both`; OBE-021): thin handlers over SearchesService. The global guards resolved
// the caller, the tenant and the scope (customer or console), the CSRF guard checked the edge's POST, the rate limits
// counted the request, the validation interceptor checked the input against the OTA document and the idempotency
// interceptor stores the search's answer under its `Idempotency-Key`. Every answer is `Cache-Control: no-store`: prices
// are live and a search may belong to a customer.
import { Controller, Get, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import { SearchesService, type FlightSearch, type FlightSearchResultsPage } from "./searches.service";

/** `Cache-Control` of every answer of these operations. */
export const SEARCH_CACHE_CONTROL = "no-store";

@Controller("v1/flight-searches")
export class SearchesController {
  constructor(private readonly searches: SearchesService) {}

  @Post()
  @OpenApiOperation("createFlightSearch")
  async create(
    @OpenApiInput() input: ValidatedInput<"createFlightSearch">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FlightSearch> {
    if (input.body === undefined) {
      // The validation interceptor refuses a request without its required body; this is never reached.
      throw new Error("createFlightSearch without a validated body");
    }
    const created = await this.searches.create({
      body: input.body,
      currencyHeader: input.headers["X-Currency"],
      acceptLanguage: input.headers["Accept-Language"],
    });
    res.setHeader("Location", created.location);
    res.setHeader("Cache-Control", SEARCH_CACHE_CONTROL);
    return created.search;
  }

  @Get(":searchId")
  @OpenApiOperation("getFlightSearch")
  async get(
    @OpenApiInput() input: ValidatedInput<"getFlightSearch">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FlightSearch> {
    const search = await this.searches.get(input.path.searchId, input.headers?.["Accept-Language"]);
    if (typeof search.retryAfterSeconds === "number") {
      res.setHeader("Retry-After", String(search.retryAfterSeconds));
    }
    res.setHeader("Cache-Control", SEARCH_CACHE_CONTROL);
    return search;
  }

  @Get(":searchId/offers")
  @OpenApiOperation("listFlightSearchResults")
  async listResults(
    @OpenApiInput() input: ValidatedInput<"listFlightSearchResults">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FlightSearchResultsPage> {
    const page = await this.searches.listResults(
      input.path.searchId,
      input.query ?? {},
      input.headers?.["Accept-Language"],
    );
    res.setHeader("Cache-Control", SEARCH_CACHE_CONTROL);
    return page;
  }
}
