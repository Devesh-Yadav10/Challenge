-- ============================================
--  Student Management System — MySQL Schema
--  With strict format validation constraints
-- ============================================

CREATE DATABASE IF NOT EXISTS student_mgmt;
USE student_mgmt;

DROP TABLE IF EXISTS students;

CREATE TABLE students (
    id            INT AUTO_INCREMENT PRIMARY KEY,

    name          VARCHAR(100)  NOT NULL,

    -- Format: YY/BRANCH/SERIALNO e.g. 24/CSE/001
    roll_number   VARCHAR(30)   NOT NULL UNIQUE,
    CONSTRAINT chk_roll  CHECK (roll_number REGEXP '^[0-9]{2}/[A-Za-z]+/[0-9]+$'),

    -- Only @gmail.com addresses
    email         VARCHAR(150)  NOT NULL UNIQUE,
    CONSTRAINT chk_email CHECK (email REGEXP '^[a-zA-Z0-9._%+\\-]+@gmail\\.com$'),

    -- Format: +91 XXXXXXXXXX (10 digits starting 6-9)
    phone         VARCHAR(15)   NOT NULL UNIQUE,
    CONSTRAINT chk_phone CHECK (phone REGEXP '^\\+91 [6-9][0-9]{9}$'),

    course        VARCHAR(100)  NOT NULL,
    year          TINYINT       NOT NULL,
    CONSTRAINT chk_year  CHECK (year BETWEEN 1 AND 4),

    dob           DATE          NOT NULL,
    gender        ENUM('Male','Female','Other') NOT NULL,
    address       TEXT,

    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Sample data
INSERT INTO students (name, email, phone, roll_number, course, year, dob, gender, address) VALUES
('Aarav Sharma', 'aarav.sharma@gmail.com', '+91 9810000001', '24/CSE/001', 'B.Tech Computer Science', 2, '2005-03-14', 'Male',   '12 Lajpat Nagar, Delhi'),
('Priya Mehta',  'priya.mehta@gmail.com',  '+91 9810000002', '24/ECE/002', 'B.Tech Electronics',      3, '2004-07-22', 'Female', '5 Saket, Delhi'),
('Rohan Verma',  'rohan.verma@gmail.com',  '+91 9810000003', '24/ME/003',  'B.Tech Mechanical',       1, '2006-11-05', 'Male',   '88 Rohini, Delhi');
