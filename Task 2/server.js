const express = require("express");
const path = require("path");
const { MongoClient, Decimal128 } = require("mongodb");

const app = express();
const port = 3000;

require("dotenv").config();

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri);

let db;
let listingsCollection;
let bookingCollection;
let registeredClientCollection;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatListing(listing) {
  return {
    id: listing._id,
    name: listing.name || "No name",
    summary: listing.summary || listing.description || "No summary available",
    price: listing.price ? listing.price.toString() : "N/A",
    property_type: listing.property_type || "N/A",
    bedrooms: listing.bedrooms ?? "N/A",
    rating: listing.review_scores?.review_scores_rating ?? "N/A",
    market: listing.address?.market || "N/A",
    country: listing.address?.country || "N/A",
    picture_url: listing.images?.picture_url || ""
  };
}

// Converts a date into date-only value.
// This ignores time, because no houry booking
function toDateOnlyValue(dateInput) {
  const date = new Date(dateInput);

  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
}

// True if an existing booking overlaps with the requested booking dates
// existing arrivalDate < requested endDate
// AND existing departureDate > requested startDate
function datesOverlap(existingArrivalDate, existingDepartureDate, requestedStartDate, requestedEndDate) {
  const existingStart = toDateOnlyValue(existingArrivalDate);
  const existingEnd = toDateOnlyValue(existingDepartureDate);
  const requestedStart = toDateOnlyValue(requestedStartDate);
  const requestedEnd = toDateOnlyValue(requestedEndDate);

  return existingStart < requestedEnd && existingEnd > requestedStart;
}

async function startServer() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas successfully");

    db = client.db("sample_airbnb");

    
    listingsCollection = db.collection("listingsAndReviews");
    bookingCollection = db.collection("Booking");
    registeredClientCollection = db.collection("registeredClient");

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(path.join(__dirname, "public")));

    app.get("/", function (req, res) {
      res.sendFile(path.join(__dirname, "public", "index.html"));
    });

    // TASK 2 HOMEPAGE:
    // Search listings, then remove unavailable listings.
    app.get("/api/listings", async function (req, res) {
      try {
        const { location, startDate, endDate, property_type, bedrooms } = req.query;

        const projection = {
          _id: 1,
          name: 1,
          summary: 1,
          description: 1,
          price: 1,
          property_type: 1,
          bedrooms: 1,
          address: 1,
          review_scores: 1,
          images: 1
        };

        // Initial random listings before search
        if (!location && !startDate && !endDate) {
          const randomListings = await listingsCollection
            .aggregate([
              { $sample: { size: 6 } },
              { $project: projection }
            ])
            .toArray();

          return res.json(randomListings.map(formatListing));
        }

        // location, start date, and end date are mandatory.
        if (!location || !startDate || !endDate) {
          return res.status(400).json({
            error: "Location, start date, and end date are required."
          });
        }

        if (new Date(startDate) >= new Date(endDate)) {
          return res.status(400).json({
            error: "End date must be after start date."
          });
        }

        const listingQuery = {
          "address.market": {
            $regex: `^${escapeRegex(location)}$`,
            $options: "i"
          }
        };

        if (property_type) {
          listingQuery.property_type = property_type;
        }

        if (bedrooms) {
          listingQuery.bedrooms = Number(bedrooms);
        }

        const listings = await listingsCollection
          .find(listingQuery, { projection })
          .limit(50)
          .toArray();

        const listingIds = listings.map(listing => listing._id);

        if (listingIds.length === 0) {
          return res.json([]);
        }

        // get bookings for the candidate listings
        // check date overlap in JavaScript using date comparison
        const relatedBookings = await bookingCollection
          .find(
            {
              listing_id: { $in: listingIds }
            },
            {
              projection: {
                listing_id: 1,
                arrivalDate: 1,
                departureDate: 1
              }
            }
          )
          .toArray();

        const unavailableListingIds = new Set();

        relatedBookings.forEach(function (booking) {
          if (
            datesOverlap(
              booking.arrivalDate,
              booking.departureDate,
              startDate,
              endDate
            )
          ) {
            unavailableListingIds.add(booking.listing_id);
          }
        });

        const availableListings = listings.filter(function (listing) {
          return !unavailableListingIds.has(listing._id);
        });

        res.json(availableListings.map(formatListing));
      } catch (error) {
        console.error("Error loading available listings:", error);
        res.status(500).json({
          error: "Failed to load available listings"
        });
      }
    });

    // Get one listing by listing_id
    app.get("/api/listing/:id", async function (req, res) {
      try {
        const listingId = req.params.id;

        // listingsAndReviews._id is a String, not ObjectId
        const listing = await listingsCollection.findOne(
          { _id: listingId },
          {
            projection: {
              _id: 1,
              name: 1,
              summary: 1,
              description: 1,
              price: 1,
              property_type: 1,
              bedrooms: 1,
              address: 1,
              review_scores: 1,
              images: 1
            }
          }
        );

        if (!listing) {
          return res.status(404).json({
            error: "Listing not found"
          });
        }

        res.json(formatListing(listing));
      } catch (error) {
        console.error("Error loading listing:", error);
        res.status(500).json({
          error: "Failed to load listing"
        });
      }
    });

    // TASK 2 BOOKING PAGE:
    // Check availability again before inserting booking.
    app.post("/api/bookings", async function (req, res) {
      try {
        const {
          listing_id,
          startDate,
          endDate,
          name,
          emailAddress,
          daytimePhoneNumber,
          mobileNumber,
          postalAddress,
          homeAddress
        } = req.body;

        if (!listing_id || !startDate || !endDate || !name || !emailAddress || !mobileNumber) {
          return res.status(400).json({
            success: false,
            error: "Missing required booking details."
          });
        }

        if (new Date(startDate) >= new Date(endDate)) {
          return res.status(400).json({
            success: false,
            error: "End date must be after start date."
          });
        }

        const listing = await listingsCollection.findOne({
          _id: listing_id
        });

        if (!listing) {
          return res.status(404).json({
            success: false,
            error: "Listing not found."
          });
        }

        // Final availability check before saving.
        const existingBookings = await bookingCollection
          .find(
            {
              listing_id: listing_id
            },
            {
              projection: {
                arrivalDate: 1,
                departureDate: 1
              }
            }
          )
          .toArray();

        const hasOverlap = existingBookings.some(function (booking) {
          return datesOverlap(
            booking.arrivalDate,
            booking.departureDate,
            startDate,
            endDate
          );
        });

        if (hasOverlap) {
          return res.json({
            success: false,
            unavailable: true,
            error: "This listing is no longer available for the selected dates."
          });
        }

        // Insert client into registeredClient collection
        const clientDocument = {
          client_id: "C" + Date.now(),
          name: name,
          emailAddress: emailAddress,
          daytimePhoneNumber: daytimePhoneNumber || "",
          mobileNumber: mobileNumber,
          postalAddress: postalAddress || "",
          homeAddress: homeAddress || ""
        };

        const clientResult = await registeredClientCollection.insertOne(clientDocument);

        // Insert booking into Booking collection
        const bookingDocument = {
          booking_id: "B" + Date.now(),

          
          // listingsAndReviews._id is String
          listing_id: listing_id,

          // References registeredClient._id
          client_id: clientResult.insertedId,

          arrivalDate: new Date(startDate),
          departureDate: new Date(endDate),

          // just to keep thing structured
          depositPaid: Decimal128.fromString("0.00"),
          balanceDue: Decimal128.fromString("0.00"),
          balanceDueDate: null,
          numberOfGuests: 0,
          guests: []
        };

        const bookingResult = await bookingCollection.insertOne(bookingDocument);

        res.json({
          success: true,
          booking_id: bookingDocument.booking_id,
          mongo_booking_id: bookingResult.insertedId
        });
      } catch (error) {
        console.error("Error creating booking:", error);
        res.status(500).json({
          success: false,
          error: "Failed to create booking."
        });
      }
    });

    app.listen(port, function () {
      console.log(`Task 2 app running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
  }
}

startServer();