CREATE TABLE `shop-prod.sales.customers` (
  id INT64 NOT NULL OPTIONS(description="Surrogate key"),
  email STRING,
  address STRUCT<street STRING, city STRING, zip STRING>,
  tags ARRAY<STRING>,
  PRIMARY KEY (id) NOT ENFORCED
)
OPTIONS(description="People who buy");

CREATE TABLE `shop-prod.sales.orders` (
  id INT64 NOT NULL,
  customer_id INT64,
  created_at TIMESTAMP,
  PRIMARY KEY (id) NOT ENFORCED,
  FOREIGN KEY (customer_id) REFERENCES `shop-prod.sales.customers`(id) NOT ENFORCED
)
PARTITION BY DATE(created_at);

CREATE TABLE `shop-prod.sales.daily` AS SELECT DATE(created_at) AS day, COUNT(*) AS n FROM `shop-prod.sales.orders` GROUP BY 1;
