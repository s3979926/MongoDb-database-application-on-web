const express = require("express");
const path = require("path");
const { MongoClient, Decimal128 } = require("mongodb");

const app = express();
const port = 3000;


const uri = "mongodb://s3979926_db_user:[Mypassword]@ac-1pqpfwl-shard-00-00.utoopyl.mongodb.net:27017,ac-1pqpfwl-shard-00-01.utoopyl.mongodb.net:27017,ac-1pqpfwl-shard-00-02.utoopyl.mongodb.net:27017/?ssl=true&replicaSet=atlas-g8xl2i-shard-0&authSource=admin&appName=DBA-Cluster";

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

    // Homepage listings API
    app.get("/api/listings", async function (req, res) {
      try {
        const { location, property_type, bedrooms } = req.query;

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

        let listings;

        // Initial random listings before search
        if (!location) {
          listings = await listingsCollection
            .aggregate([
              { $sample: { size: 6 } },
              { $project: projection }
            ])
            .toArray();
        } else {
          const query = {
            "address.market": {
              $regex: `^${escapeRegex(location)}$`,
              $options: "i"
            }
          };

          if (property_type) {
            query.property_type = property_type;
          }

          if (bedrooms) {
            query.bedrooms = Number(bedrooms);
          }

          listings = await listingsCollection
            .find(query, { projection })
            .limit(20)
            .toArray();
        }

        res.json(listings.map(formatListing));
      } catch (error) {
        console.error("Error loading listings:", error);
        res.status(500).json({ error: "Failed to load listings" });
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
          return res.status(404).json({ error: "Listing not found" });
        }

        res.json(formatListing(listing));
      } catch (error) {
        console.error("Error loading listing:", error);
        res.status(500).json({ error: "Failed to load listing" });
      }
    });

    // Create booking
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
            error: "Missing required booking details"
          });
        }

        // Check listing exists
        const listing = await listingsCollection.findOne({ _id: listing_id });

        if (!listing) {
          return res.status(404).json({
            success: false,
            error: "Listing not found"
          });
        }

        // Insert into registeredClient collection
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

        // Insert into Booking collection
        const bookingDocument = {
          booking_id: "B" + Date.now(),

          
          // listingsAndReviews._id is a String
          listing_id: listing_id,

          // Booking.client_id references registeredClient._id
          client_id: clientResult.insertedId,

          arrivalDate: new Date(startDate),
          departureDate: new Date(endDate),

          // paymnent no require but to make things structured
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
          error: "Failed to create booking"
        });
      }
    });

    app.listen(port, function () {
      console.log(`Task 1 app running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
  }
}

startServer();
